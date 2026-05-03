require("dotenv").config();

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

// Carga el system prompt desde archivo separado
const SYSTEM_PROMPT = fs.existsSync(path.join(__dirname, "system_prompt.txt"))
  ? fs.readFileSync(path.join(__dirname, "system_prompt.txt"), "utf8").trim()
  : process.env.SYSTEM_PROMPT || "Eres un asistente virtual de Airbnb.";

const KNOWLEDGE_BASE = fs.existsSync(path.join(__dirname, "knowledge.txt"))
  ? fs.readFileSync(path.join(__dirname, "knowledge.txt"), "utf8").trim()
  : "";

const HOST_WHATSAPP = process.env.HOST_WHATSAPP_NUMBER || 'whatsapp:+56977541568';

const app = express();

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

app.use(express.urlencoded({ extended: false }));

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const THINKING_MESSAGES = [
  "Un momento, déjame pensar en la mejor respuesta para ti... 🤔",
  "Dame un segundo, estoy en eso... ✨",
  "Consultando mis apuntes de Santiago... 📍",
  "Justo lo que necesitaba preguntarme, dame un momento... 💬",
];

const MODEL = "claude-haiku-4-5";
const MAX_TURNS = 10;
const INACTIVITY_MS = 24 * 60 * 60 * 1000; // 24 horas

const IMAGE_BASE_URL = "https://github.com/vicencioesteban0-beep/airbnb-bot/blob/main/images/";

// Mapa de etiquetas a archivos de imagen
const IMAGE_MAP = {
  living:        "living.jpg",
  cocina:        "cocina.jpg",
  agua:          "agua.jpg",
  vino:          "vino.jpg",
  bano:          "bano.jpg",
  dispensadores: "dispensadores.jpg",
  lavadora:      "lavadora.jpg",
  velador:       "velador.jpg",
};

// Extrae etiquetas [IMAGE:key] del texto y devuelve { cleanText, imageKeys }
function extractImageTags(text) {
  const imageKeys = [];
  const cleanText = text.replace(/\[IMAGE:(\w+)\]/g, (match, key) => {
    if (IMAGE_MAP[key]) imageKeys.push(key);
    return "";
  }).trim();
  return { cleanText, imageKeys };
}

// Historial de conversaciones por número de teléfono
// { phoneNumber: { messages: [...], lastActivity: Date } }
const conversations = new Map();

function getConversation(phone) {
  const now = Date.now();

  if (conversations.has(phone)) {
    const conv = conversations.get(phone);
    // Limpiar si lleva más de 24h inactiva
    if (now - conv.lastActivity > INACTIVITY_MS) {
      conversations.delete(phone);
    } else {
      conv.lastActivity = now;
      return conv;
    }
  }

  const conv = { messages: [], lastActivity: now };
  conversations.set(phone, conv);
  return conv;
}

function pruneOldConversations() {
  const now = Date.now();
  for (const [phone, conv] of conversations.entries()) {
    if (now - conv.lastActivity > INACTIVITY_MS) {
      conversations.delete(phone);
    }
  }
}

// Limpiar conversaciones inactivas cada hora
setInterval(pruneOldConversations, 60 * 60 * 1000);

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const incomingMsg = req.body.Body?.trim();
    const from = req.body.From;

    if (!incomingMsg || !from) {
      twiml.message("No pude procesar tu mensaje. Por favor intenta de nuevo.");
      return res.type("text/xml").send(twiml.toString());
    }

    const conv = getConversation(from);

    // Agregar mensaje del usuario
    conv.messages.push({ role: "user", content: incomingMsg });

    // Mantener máximo 10 turnos (20 mensajes: 10 user + 10 assistant)
    if (conv.messages.length > MAX_TURNS * 2) {
      conv.messages = conv.messages.slice(-MAX_TURNS * 2);
    }

    // Enviar mensaje de "pensando" antes de llamar a Claude
    const thinkingMsg = THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)];
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: thinkingMsg,
    });

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT + (KNOWLEDGE_BASE ? "\n\n=== BASE DE CONOCIMIENTO ===\n" + KNOWLEDGE_BASE : ""),
      messages: conv.messages,
    });

    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Extraer etiquetas de imagen y limpiar el texto
    const { cleanText, imageKeys } = extractImageTags(rawText);

    // Guardar en historial el texto limpio (sin etiquetas)
    conv.messages.push({ role: "assistant", content: cleanText });

    // Mensaje de texto + imagen combinados en uno solo
    const msg = twiml.message(cleanText);
    if (imageKeys.length > 0) {
      const imageUrl = IMAGE_BASE_URL + IMAGE_MAP[imageKeys[0]] + "?raw=true";
      msg.media(imageUrl);
    }
  } catch (err) {
    console.error("Error al procesar mensaje:", err);
    twiml.message("Ocurrió un error. Por favor intenta de nuevo en un momento.");
  }

  res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
