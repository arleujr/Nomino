import { kv } from '@vercel/kv';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { getAuthenticatedClient } from './auth.js';

async function generatePdfFromJob(jobData) {
    const {
        participant,
        templateBase64,
        signaturesBase64,
        layout
    } = jobData;
    
    const { name: nameSettings, signatures: signatureSettings, editorDimensions } = layout;

    const pdfDoc = await PDFDocument.create();

    const templateBytes = Buffer.from(templateBase64.split(',')[1], 'base64');
    let embeddedTemplate;
    try {
        embeddedTemplate = await pdfDoc.embedPng(templateBytes);
    } catch {
        embeddedTemplate = await pdfDoc.embedJpg(templateBytes);
    }

    const font = nameSettings.fontFamily?.toLowerCase().includes('times')
        ? await pdfDoc.embedFont(StandardFonts.TimesRoman)
        : await pdfDoc.embedFont(StandardFonts.Helvetica);

    const embeddedSignatures = [];
    for (const sigBase64 of signaturesBase64) {
        const sigBytes = Buffer.from(sigBase64.split(',')[1], 'base64');
        embeddedSignatures.push(await pdfDoc.embedPng(sigBytes));
    }

    const page = pdfDoc.addPage([embeddedTemplate.width, embeddedTemplate.height]);
    const { width: originalWidth, height: originalHeight } = page.getSize();
    page.drawImage(embeddedTemplate, { x: 0, y: 0, width: originalWidth, height: originalHeight });
    
    const { width: displayedWidth } = editorDimensions;
    const scale = originalWidth / displayedWidth;
    
    const cssOffset = 6 * scale;
    const scaledX = nameSettings.x * scale;
    const scaledYTop = nameSettings.y * scale;
    const finalX = scaledX + cssOffset;
    const scaledYTopText = scaledYTop + cssOffset;
    const scaledFontSize = nameSettings.fontSize * scale;
    const finalYTopPdf = originalHeight - scaledYTopText;
    const visualCompensation = 0.85;
    const finalY = finalYTopPdf - (scaledFontSize * visualCompensation);
    page.drawText(participant.nome, {
        x: finalX, y: finalY,
        size: scaledFontSize, font: font,
        color: hexToRgb(nameSettings.color),
    });

    const scaledCssMaxHeight = 120 * scale;
    const sigCssOffset = 1 * scale;
    
    for (let i = 0; i < signatureSettings.length; i++) {
        const sigImg = embeddedSignatures[i];
        const sigPos = signatureSettings[i]; 
        
        let sigWidth, sigHeight;
        if (sigImg.height > scaledCssMaxHeight) {
            const sizeScale = scaledCssMaxHeight / sigImg.height;
            sigWidth = sigImg.width * sizeScale;
            sigHeight = scaledCssMaxHeight;
        } else {
            sigWidth = sigImg.width;
            sigHeight = sigImg.height;
        }
        const scaledSigX = sigPos.x * scale;
        const scaledSigYTop = sigPos.y * scale;
        const finalSigX = scaledSigX + sigCssOffset;
        const scaledSigYTopImg = scaledSigYTop + sigCssOffset;
        const verticalCompensation = sigHeight * 0.08;
        const finalSigY = originalHeight - scaledSigYTopImg - sigHeight + verticalCompensation;
        page.drawImage(sigImg, {
            x: finalSigX, y: finalSigY,
            width: sigWidth, height: sigHeight,
        });
    }

    return await pdfDoc.save();
}

async function sendEmail(authClient, userEmail, jobData, pdfBytes) {
    const { participant, emailContent } = jobData;
    
    const { token } = await authClient.getAccessToken();

    if (!userEmail) {
        throw new Error("O e-mail do usuário autenticado não foi encontrado.");
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            type: 'OAuth2',
            user: userEmail,
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            refreshToken: authClient.credentials.refresh_token,
            accessToken: token,
        },
    });

    const personalizedBody = emailContent.body.replace(/{{NOME}}/gi, participant.nome);

    const mailOptions = {
        from: userEmail,
        to: participant.email,
        subject: emailContent.subject,
        text: personalizedBody,
        html: personalizedBody.replace(/\n/g, '<br>'),
        attachments: [
            {
                filename: `${participant.nome.replace(/ /g, '_')}_certificado.pdf`,
                content: Buffer.from(pdfBytes),
                contentType: 'application/pdf',
            },
        ],
    };

    await transporter.sendMail(mailOptions);
}

export async function processQueue() {
    console.log("WORKER: Iniciando. Procurando jobs...");
    
    const BATCH_SIZE = 10; 
    const jobKeys = await kv.keys('job:*');
    
    if (jobKeys.length === 0) {
        console.log("WORKER: Fila vazia. Dormindo.");
        return { success: true, message: "Fila vazia." };
    }

    const keysToProcess = jobKeys.slice(0, BATCH_SIZE);
    console.log(`WORKER: Fila tem ${jobKeys.length} jobs. Processando um lote de ${keysToProcess.length}...`);

    let authClient, userEmail;
    try {
        const authData = await getAuthenticatedClient();
        authClient = authData.client;
        userEmail = authData.userEmail;
    } catch (authError) {
        console.error("WORKER: Erro de autenticação. Não é possível processar o lote.", authError);
        return { success: false, message: "Falha ao autenticar. Verifique o login do Google." };
    }

    let successCount = 0;
    let failCount = 0;

    for (const jobKey of keysToProcess) {
        let jobData;
        try {
            jobData = await kv.get(jobKey);
            if (!jobData) {
                throw new Error("Job data está nulo ou corrompido.");
            }

            console.log(`WORKER (Lote): Gerando PDF para ${jobData.participant.nome}...`);
            const pdfBytes = await generatePdfFromJob(jobData);

            console.log(`WORKER (Lote): Enviando e-mail para ${jobData.participant.email}...`);
            await sendEmail(authClient, userEmail, jobData, pdfBytes);

            await kv.del(jobKey);
            successCount++;

        } catch (error) {
            console.error(`WORKER (Lote): Erro grave ao processar job ${jobKey} para ${jobData?.participant?.email}:`, error.message);
            failCount++;
            
            await kv.set(`failed:${jobKey}`, { ...jobData, error: error.message }, { ex: 60 * 60 * 24 * 7 });
            await kv.del(jobKey);
        }
    }

    const summary = `Lote completo. Processados: ${keysToProcess.length}, Sucesso: ${successCount}, Falha: ${failCount}`;
    console.log(`WORKER: ${summary}`);
    return { success: true, message: summary };
}

function hexToRgb(hex) {
    if (!hex) return rgb(0, 0, 0);
    hex = hex.replace(/^#/, '');
    const bigint = parseInt(hex, 16);
    if (hex.length === 3) {
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        return rgb(r / 255, g / 255, b / 255);
    } else if (hex.length === 6) {
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return rgb(r / 255, g / 255, b / 255);
    }
    return rgb(0, 0, 0);
}