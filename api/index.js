import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import archiver from 'archiver';
import { kv } from '@vercel/kv';
import { randomUUID } from 'crypto';

import { getGoogleAuthUrl, handleGoogleCallback, getAuthenticatedClient } from './auth.js';
import { processQueue } from './worker.js';

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage
}).fields([
    { name: 'template', maxCount: 1 },
    { name: 'signatures', maxCount: 10 }
]);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/api/test', (req, res) => {
    console.log('Received request at /api/test');
    res.json({ message: 'Olá! O backend do Gerador de Certificados está no ar! 🚀' });
});

app.post('/api/generate-zip', upload, async (req, res) => {
    try {
        console.log("Received request at /api/generate-zip");
        if (!req.files || !req.files.template) {
            return res.status(400).send('Error: Template file is required.');
        }
        const templateBuffer = req.files.template[0].buffer;
        const signatureBuffers = (req.files.signatures || []).map(file => file.buffer);
        const settings = JSON.parse(req.body.settings);
        const { participants, name: nameSettings, signatures: signatureSettings, editorDimensions } = settings;
        if (!editorDimensions || editorDimensions.width === 0) {
            return res.status(400).send('Error: Invalid editor dimensions.');
        }
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=certificados_verificacao.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);
        for (const participant of participants) {
            const pdfBytes = await generateSinglePdf(
                templateBuffer,
                participant.nome,
                nameSettings,
                signatureBuffers,
                signatureSettings,
                editorDimensions
            );
            archive.append(Buffer.from(pdfBytes), {
                name: `${participant.nome}.pdf`
            });
        }
        await archive.finalize();
    } catch (error) {
        console.error("Error generating ZIP:", error);
        res.status(500).send(`Server Error: ${error.message}`);
    }
});

app.get('/api/auth/google', (req, res) => {
  try {
    const authUrl = getGoogleAuthUrl();
    res.redirect(authUrl);
  } catch (error) {
    res.status(500).send("Error initiating authentication.");
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send("Error: Google callback code is missing.");
  }
  try {
    await handleGoogleCallback(code);
    res.redirect(`${process.env.ROOT_URL}/#step-2`);
  } catch (error) {
    res.status(500).send("Error during authentication callback.");
  }
});

app.get('/api/auth/status', async (req, res) => {
  try {
    await getAuthenticatedClient(); 
    res.json({ isAuthenticated: true });
  } catch (error) {
    res.json({ isAuthenticated: false });
  }
});

app.post('/api/queue-job', async (req, res) => {
    try {
        console.log("Received request at /api/queue-job. Validating job...");
        await getAuthenticatedClient();
        const {
            participants, templateBase64, signaturesBase64, layout, emailContent
        } = req.body;
        if (!participants || !templateBase64 || !layout || !emailContent) {
            return res.status(400).send("Erro: Dados do 'job' estão incompletos.");
        }
        console.log(`Job received. Queuing ${participants.length} individual email jobs...`);
        for (const participant of participants) {
            const jobId = randomUUID();
            const jobDetails = {
                participant: participant,
                templateBase64: templateBase64,
                signaturesBase64: signaturesBase64,
                layout: layout,
                emailContent: emailContent
            };
            await kv.set(`job:${jobId}`, jobDetails, { ex: 60 * 60 * 24 });
        }
        console.log("All jobs successfully queued.");
        res.status(200).json({ 
            message: "Jobs agendados com sucesso!",
            totalJobs: participants.length 
        });
    } catch (error) {
        console.error("Erro grave ao agendar 'jobs':", error);
        if (error.message.includes("User is not authenticated")) {
            return res.status(401).send("Erro de autenticação. Faça login novamente.");
        }
        res.status(500).send(`Erro interno do servidor: ${error.message}`);
    }
});

app.get('/api/process-queue', async (req, res) => {
    try {
        const result = await processQueue();
        res.status(200).json(result);
    } catch (error) {
        console.error("Erro na rota /api/process-queue:", error.message);
        res.status(500).json({ success: false, message: `Erro no worker: ${error.message}` });
    }
});

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

async function generateSinglePdf(
    templateBuffer,
    name,
    nameSettings,
    sigBuffers,
    sigSettings,
    editorDimensions
) {
    const pdfDoc = await PDFDocument.create();
    let embeddedTemplate;
    try {
        embeddedTemplate = await pdfDoc.embedPng(templateBuffer);
    } catch {
        embeddedTemplate = await pdfDoc.embedJpg(templateBuffer);
    }
    const font = nameSettings.fontFamily?.toLowerCase().includes('times')
        ? await pdfDoc.embedFont(StandardFonts.TimesRoman)
        : await pdfDoc.embedFont(StandardFonts.Helvetica);
    const embeddedSignatures = [];
    for (const sigBuffer of sigBuffers) {
        embeddedSignatures.push(await pdfDoc.embedPng(sigBuffer));
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
    page.drawText(name, {
        x: finalX, y: finalY,
        size: scaledFontSize, font: font,
        color: hexToRgb(nameSettings.color),
    });
    const scaledCssMaxHeight = 120 * scale;
    const sigCssOffset = 1 * scale;
    for (let i = 0; i < sigSettings.length; i++) {
        const sigImg = embeddedSignatures[i];
        const sigPos = sigSettings[i];
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

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

export default app;
