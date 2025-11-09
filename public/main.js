const templateUpload = document.getElementById('template-upload');
const csvUpload = document.getElementById('csv-upload');
const signatureUpload = document.getElementById('signature-upload');
const editorArea = document.getElementById('editor-area');
const templateImage = document.getElementById('template-image');
const controlsSection = document.getElementById('controls-section');
const fontSizeInput = document.getElementById('font-size');
const fontColorInput = document.getElementById('font-color');
const fontFamilyInput = document.getElementById('font-family');
const generateButton = document.getElementById('btn-generate-zip');

const btnGotoEmail = document.getElementById('btn-goto-email');
const step1Card = document.getElementById('step-1-editor');
const step2Card = document.getElementById('step-2-email');
const authSection = document.getElementById('auth-section');
const authStatus = document.getElementById('auth-status');
const btnLoginGoogle = document.getElementById('btn-login-google');
const emailSection = document.getElementById('email-section');
const btnSendQueue = document.getElementById('btn-send-queue');
const emailSubject = document.getElementById('email-subject');
const emailBody = document.getElementById('email-body');

let state = {
    participants: [],
    longestName: "",
    templateLoaded: false,
    csvLoaded: false,
    previewElement: null,
    selectedElement: null,
    isAuthenticated: false,
    templateBase64: null,
    signaturesBase64: [],
    editorDimensions: null
};

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM carregado.");
    handleHashChange();
});

window.addEventListener('hashchange', handleHashChange);

function handleHashChange() {
    const hash = window.location.hash;
    
    if (hash === '#step-2') {
        step1Card.style.display = 'none';
        step2Card.style.display = 'block';
        console.log("Navegando para a Etapa 2.");
        checkAuthStatus();
    } else {
        step1Card.style.display = 'block';
        step2Card.style.display = 'none';
        console.log("Navegando para a Etapa 1.");
    }
}

async function checkAuthStatus() {
    try {
        authStatus.innerText = "Verificando status de autenticação...";
        authStatus.style.display = 'block';
        const response = await fetch('/api/auth/status');
        if (!response.ok) throw new Error('Falha ao verificar status de autenticação.');
        const data = await response.json();
        state.isAuthenticated = data.isAuthenticated;
        updateAuthUI(state.isAuthenticated);
    } catch (error) {
        console.error("Erro ao verificar autenticação:", error);
        authStatus.innerText = "Erro ao verificar autenticação.";
        authStatus.style.color = 'red';
        updateAuthUI(false);
    }
}

function updateAuthUI(isAuthenticated) {
    if (isAuthenticated) {
        console.log("Usuário está AUTENTICADO.");
        authSection.style.display = 'none';
        emailSection.style.display = 'block';
    } else {
        console.log("Usuário NÃO está autenticado.");
        authSection.style.display = 'block';
        emailSection.style.display = 'none';
        authStatus.style.display = 'none';
    }
}

function goToStep2() {
    window.location.hash = 'step-2';
}

templateUpload.addEventListener('change', handleTemplateUpload);
csvUpload.addEventListener('change', handleCsvUpload);
signatureUpload.addEventListener('change', handleSignatureUpload);
fontSizeInput.addEventListener('input', () => { applyTextStyles(state.previewElement); });
fontColorInput.addEventListener('input', () => { applyTextStyles(state.previewElement); });
fontFamilyInput.addEventListener('input', () => { applyTextStyles(state.previewElement); });
document.addEventListener('keydown', handleKeyboardControls);
generateButton.addEventListener('click', handleGenerateZip);
btnGotoEmail.addEventListener('click', goToStep2);
btnLoginGoogle.addEventListener('click', () => {
    console.log("Iniciando login com Google...");
    window.location.href = '/api/auth/google';
});
btnSendQueue.addEventListener('click', handleSendQueue);

async function handleTemplateUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        state.templateBase64 = await fileToBase64(file);
        console.log("Template salvo como Base64.");
    } catch (error) {
        console.error("Erro ao converter template para Base64:", error);
        alert("Erro ao ler o template.");
        return;
    }
    
    const reader = new FileReader();
    reader.onload = (e) => {
        templateImage.src = e.target.result;
        templateImage.onload = () => {
            templateImage.style.display = 'block';
            
            const editorRect = templateImage.getBoundingClientRect();
            state.editorDimensions = {
                width: editorRect.width,
                height: editorRect.height
            };
            console.log("Template carregado e dimensões salvas:", state.editorDimensions);

            state.templateLoaded = true;
            checkIfReadyToGenerate();
        };
    };
    reader.readAsDataURL(file);
}

function handleCsvUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
            if (!results.meta.fields.includes('nome') || !results.meta.fields.includes('email')) {
                alert("Erro no CSV! Verifique se as colunas 'nome' e 'email' existem.");
                csvUpload.value = "";
                return;
            }
            state.participants = results.data.map(row => ({ nome: row.nome, email: row.email }));
            state.longestName = findLongestName(state.participants);
            createNamePreview(state.longestName);
            state.csvLoaded = true;
            checkIfReadyToGenerate();
        },
        error: (err) => { alert("Ocorreu um erro ao ler o CSV: " + err.message); }
    });
}

async function handleSignatureUpload(event) {
    const files = event.target.files;
    if (!files.length) return;
    state.signaturesBase64 = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        
        try {
            const base64String = await fileToBase64(file);
            state.signaturesBase64.push(base64String);
            console.log(`Assinatura ${i} salva como Base64.`);
        } catch (error) {
            console.error("Erro ao converter assinatura para Base64:", error);
            alert(`Erro ao ler a assinatura ${file.name}.`);
            continue;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const sigImage = document.createElement('img');
            sigImage.src = e.target.result;
            sigImage.className = 'draggable signature-image';
            editorArea.appendChild(sigImage);
            const initialX = 50;
            const initialY = 50 + (i * 30);
            makeDraggable(sigImage, initialX, initialY);
            sigImage.setAttribute('tabindex', 0);
            sigImage.addEventListener('focus', () => { state.selectedElement = sigImage; });
            sigImage.addEventListener('blur', () => { state.selectedElement = null; });
        };
        reader.readAsDataURL(file);
    }
}

async function handleSendQueue(event) {
    event.preventDefault();
    console.log("Iniciando processo de agendamento...");
    btnSendQueue.disabled = true;
    btnSendQueue.innerText = 'Agendando, aguarde...';

    try {
        if (!state.csvLoaded || !state.templateLoaded || !state.previewElement) {
            throw new Error("Dados da Etapa 1 (Template, CSV ou Posições) não foram carregados. Por favor, volte para a Etapa 1 e configure o layout.");
        }

        const subject = emailSubject.value;
        const body = emailBody.value;
        if (!subject || !body) {
            throw new Error("O Assunto e o Corpo do e-mail são obrigatórios.");
        }

        const nameSettings = {
            x: parseFloat(state.previewElement.style.left),
            y: parseFloat(state.previewElement.style.top),
            fontSize: parseInt(fontSizeInput.value),
            fontFamily: fontFamilyInput.value,
            color: fontColorInput.value
        };

        const signatureSettings = [];
        document.querySelectorAll('.signature-image').forEach((sig) => {
            signatureSettings.push({
                x: parseFloat(sig.style.left),
                y: parseFloat(sig.style.top)
            });
        });

        const editorDimensions = state.editorDimensions;
        if (!editorDimensions || editorDimensions.width === 0) {
            throw new Error("Ocorreu um erro de renderização do template (dimensões não salvas).");
        }
        
        const jobData = {
            participants: state.participants,
            templateBase64: state.templateBase64,
            signaturesBase64: state.signaturesBase64,
            layout: {
                name: nameSettings,
                signatures: signatureSettings,
                editorDimensions: editorDimensions
            },
            emailContent: {
                subject: subject,
                body: body
            }
        };

        console.log("Enviando 'job' para /api/queue-job...");
        const response = await fetch('/api/queue-job', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(jobData)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Erro do servidor: ${errorText}`);
        }

        const result = await response.json();
        console.log("Job agendado com sucesso:", result);
        alert(`Sucesso! ${result.totalJobs} e-mails foram agendados.\nO robô começará a enviá-los em segundo plano.`);

    } catch (error) {
        console.error("Erro ao agendar envios:", error);
        alert(`Ocorreu um erro: ${error.message}`);
    } finally {
        btnSendQueue.disabled = false;
        btnSendQueue.innerText = 'Agendar Envios';
    }
}


function findLongestName(participants) {
    return participants.reduce((longest, participant) => {
        if (participant.nome.length > longest.length) {
            return participant.nome;
        }
        return longest;
    }, "");
}

function createNamePreview(name) {
    if (state.previewElement) {
        state.previewElement.remove();
    }
    const namePreview = document.createElement('div');
    namePreview.id = 'preview-name';
    namePreview.className = 'draggable';
    namePreview.innerText = name;
    applyTextStyles(namePreview);
    editorArea.appendChild(namePreview);
    state.previewElement = namePreview;
    makeDraggable(namePreview, 20, 20);
    namePreview.setAttribute('tabindex', 0);
    namePreview.addEventListener('focus', () => {
        state.selectedElement = namePreview;
        namePreview.style.border = '1px dashed #ff0000';
    });
    namePreview.addEventListener('blur', () => {
        state.selectedElement = null;
        namePreview.style.border = '1px dashed #007bff';
    });
    controlsSection.style.display = 'block';
}

function applyTextStyles(element) {
    if (!element) return;
    element.style.fontSize = `${fontSizeInput.value}px`;
    element.style.color = fontColorInput.value;
    element.style.fontFamily = fontFamilyInput.value;
}

function checkIfReadyToGenerate() {
    if (state.templateLoaded && state.csvLoaded) {
        generateButton.disabled = false;
        btnGotoEmail.disabled = false;
        console.log("Pronto para gerar!");
    }
}

function makeDraggable(element, initialX, initialY) {
    element.style.position = 'absolute';
    element.style.left = `${initialX || 0}px`;
    element.style.top = `${initialY || 0}px`;
    interact(element)
        .draggable({
            listeners: {
                move(event) {
                    let x = (parseFloat(event.target.style.left) || 0) + event.dx;
                    let y = (parseFloat(event.target.style.top) || 0) + event.dy;
                    event.target.style.left = `${x}px`;
                    event.target.style.top = `${y}px`;
                },
                end(event) {}
            },
            modifiers: [
                interact.modifiers.restrictRect({ restriction: 'parent' })
            ],
            inertia: false
        });
}

function handleKeyboardControls(event) {
    if (!state.selectedElement) return;
    let x = parseFloat(state.selectedElement.style.left) || 0;
    let y = parseFloat(state.selectedElement.style.top) || 0;
    let moved = false;
    switch (event.key) {
        case 'ArrowUp': event.preventDefault(); y -= 1; moved = true; break;
        case 'ArrowDown': event.preventDefault(); y += 1; moved = true; break;
        case 'ArrowLeft': event.preventDefault(); x -= 1; moved = true; break;
        case 'ArrowRight': event.preventDefault(); x += 1; moved = true; break;
    }
    if (moved) {
        state.selectedElement.style.left = `${x}px`;
        state.selectedElement.style.top = `${y}px`;
    }
}

async function handleGenerateZip(event) {
    event.preventDefault();
    let zipFileName = prompt("Qual nome você quer dar ao arquivo .zip de verificação?", "certificados_verificacao");
    if (zipFileName === null) return; 
    if (!zipFileName.toLowerCase().endsWith('.zip')) zipFileName += '.zip';

    generateButton.disabled = true;
    generateButton.innerText = 'Gerando, aguarde...';

    try {
        const formData = new FormData();
        formData.append('template', templateUpload.files[0]);
        Array.from(signatureUpload.files).forEach((file) => {
            formData.append('signatures', file); 
        });

        const nameSettings = {
            x: parseFloat(state.previewElement.style.left),
            y: parseFloat(state.previewElement.style.top),
            fontSize: parseInt(fontSizeInput.value),
            fontFamily: fontFamilyInput.value,
            color: fontColorInput.value
        };

        const signatureSettings = [];
        document.querySelectorAll('.signature-image').forEach((sig) => {
            signatureSettings.push({
                x: parseFloat(sig.style.left),
                y: parseFloat(sig.style.top)
            });
        });

        const editorDimensions = state.editorDimensions;
        if (!editorDimensions || editorDimensions.width === 0) {
            throw new Error("Dimensões do template não foram salvas. Recarregue a página.");
        }

        const settings = {
            participants: state.participants,
            name: nameSettings,
            signatures: signatureSettings,
            editorDimensions: editorDimensions
        };
        
        formData.append('settings', JSON.stringify(settings));

        const response = await fetch('/api/generate-zip', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Erro do servidor: ${errorText}`);
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = zipFileName; 
        document.body.appendChild(a);
        a.click();
        
        window.URL.revokeObjectURL(url);
        a.remove();
        
        alert("Download dos certificados concluído!");

    } catch (error) {
        console.error("Erro ao gerar ZIP:", error);
        alert(`Ocorreu um erro: ${error.message}`);
    } finally {
        generateButton.disabled = false;
        generateButton.innerText = 'Gerar Certificados';
    }
}