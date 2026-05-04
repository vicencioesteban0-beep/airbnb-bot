require("dotenv").config();

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

const { MessagingResponse } = twilio.twiml;

// ─── ARCHIVOS DE CONFIGURACIÓN ────────────────────────────────────────────────

const SYSTEM_PROMPT = fs.existsSync(path.join(__dirname, "system_prompt.txt"))
  ? fs.readFileSync(path.join(__dirname, "system_prompt.txt"), "utf8").trim()
  : process.env.SYSTEM_PROMPT || "Eres un asistente virtual de Airbnb.";

const KNOWLEDGE_BASE = fs.existsSync(path.join(__dirname, "knowledge.txt"))
  ? fs.readFileSync(path.join(__dirname, "knowledge.txt"), "utf8").trim()
  : "";

const HOST_WHATSAPP = process.env.HOST_WHATSAPP_NUMBER || "whatsapp:+56977541568";
const HOST_NUMBER   = process.env.HOST_NUMBER           || "56977541568";

// ─── RESERVAS ─────────────────────────────────────────────────────────────────

const RESERVATIONS_FILE = path.join(__dirname, "reservations.json");

function loadReservations() {
  try {
    if (fs.existsSync(RESERVATIONS_FILE)) {
      return JSON.parse(fs.readFileSync(RESERVATIONS_FILE, "utf8"));
    }
  } catch (e) {}
  return { reservations: {} };
}

function saveReservations(data) {
  try {
    fs.writeFileSync(RESERVATIONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error saving reservations:", e.message);
  }
}

function getGuestReservation(phoneNumber) {
  const clean = phoneNumber.replace("whatsapp:+", "").replace("whatsapp:", "");
  const data = loadReservations();
  return data.reservations[clean] || null;
}

function saveGuestReservation(phoneNumber, reservationData) {
  const clean = phoneNumber.replace("whatsapp:+", "").replace("whatsapp:", "");
  const data = loadReservations();
  data.reservations[clean] = reservationData;
  saveReservations(data);
}

function isHost(fromNumber) {
  const clean = fromNumber.replace("whatsapp:+", "").replace("whatsapp:", "");
  return clean === HOST_NUMBER;
}

// ─── EXPRESS & CLIENTES ───────────────────────────────────────────────────────

const app = express();

app.use((req, res, next) => {
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.urlencoded({ extended: false }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

const anthropic    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const THINKING_MESSAGES = [
  "Un momento, déjame pensar en la mejor respuesta para ti... 🤔",
  "Dame un segundo, estoy en eso... ✨",
  "Consultando mis apuntes de Santiago... 📍",
  "Justo lo que necesitaba preguntarme, dame un momento... 💬",
];

const MODEL         = "claude-haiku-4-5";
const MAX_TURNS     = 10;
const INACTIVITY_MS = 24 * 60 * 60 * 1000;

const IMAGE_BASE_URL = "https://github.com/vicencioesteban0-beep/airbnb-bot/blob/main/images/";

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function extractImageTags(text) {
  const imageKeys = [];
  const cleanText = text.replace(/\[IMAGE:(\w+)\]/g, (match, key) => {
    if (IMAGE_MAP[key]) imageKeys.push(key);
    return "";
  }).trim();
  return { cleanText, imageKeys };
}

// ─── CONVERSACIONES ───────────────────────────────────────────────────────────

const conversations = new Map();

function getConversation(phone) {
  const now = Date.now();
  if (conversations.has(phone)) {
    const conv = conversations.get(phone);
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

setInterval(pruneOldConversations, 60 * 60 * 1000);

// ─── KEYWORDS DE ALERTA ───────────────────────────────────────────────────────

const URGENCY_KEYWORDS = [
  "urgente", "urgent", "urgency",
  "emergencia", "emergency",
  "no puedo entrar", "cant get in", "cannot enter", "locked out",
  "necesito al anfitrión", "necesito al anfitrion", "need the host", "anfitrion",
  "llámame", "llamame", "call me", "necesito hablar",
  "problema grave", "serious problem",
  "accidente", "accident",
  "me robaron", "robaron", "stolen",
  "perdí las llaves", "perdi las llaves", "lost my keys",
  "socorro", "help me", "ayuda urgente",
  "necesito que me contacten", "contact me", "contacte",
];

const SERVICE_KEYWORDS = [
  "tabla de quesos", "cheese board", "quesos",
  "vinos", "wine", "vino chileno",
  "servicio adicional", "quiero ordenar", "quiero pedir",
  "i want to order", "me gustaría pedir", "me gustaria pedir",
];

const CHECKOUT_KEYWORDS = [
  "checkout", "check out",
  "me voy", "estoy saliendo", "ya salí", "ya sali",
  "leaving", "i am leaving", "saindo",
];

async function checkAndSendAlert(userMessage, fromNumber) {
  try {
    const msg        = userMessage.toLowerCase();
    const guestPhone = fromNumber.replace("whatsapp:", "");

    let alertType = null;
    if (URGENCY_KEYWORDS.some((kw) => msg.includes(kw)))       alertType = "urgency";
    else if (SERVICE_KEYWORDS.some((kw) => msg.includes(kw)))  alertType = "service";
    else if (CHECKOUT_KEYWORDS.some((kw) => msg.includes(kw))) alertType = "checkout";

    if (!alertType) return;

    let alertMessage;
    if (alertType === "urgency") {
      alertMessage =
        `🚨 LLAMA AHORA — Depto 611\n` +
        `Huésped necesita contacto urgente.\n` +
        `📞 Llama a este número: ${guestPhone}\n` +
        `💬 Escribió: "${userMessage}"`;
    } else if (alertType === "service") {
      alertMessage =
        `🍷 SERVICIO SOLICITADO — Depto 611\n` +
        `📞 Número huésped: ${guestPhone}\n` +
        `💬 Solicitó: "${userMessage}"`;
    } else {
      alertMessage =
        `✅ CHECKOUT — Depto 611\n` +
        `📞 Número: ${guestPhone}\n` +
        `💬 Mensaje: "${userMessage}"`;
    }

    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: HOST_WHATSAPP,
      body: alertMessage,
    });

    console.log(`[ALERTA ${alertType.toUpperCase()}] Enviada al host. Huésped: ${guestPhone}`);
  } catch (err) {
    console.error("[checkAndSendAlert] Error al enviar alerta:", err.message);
  }
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body.Body?.trim();
    const from = req.body.From;

    if (!body || !from) {
      const twiml = new MessagingResponse();
      twiml.message("No pude procesar tu mensaje. Por favor intenta de nuevo.");
      return res.type("text/xml").send(twiml.toString());
    }

    // ── FLUJO DEL ANFITRIÓN ────────────────────────────────────────────────────
    if (isHost(from)) {
      const mediaUrl  = req.body.MediaUrl0;
      const mediaType = req.body.MediaContentType0;

      // Procesar imagen de reserva
      if (mediaUrl && mediaType && mediaType.startsWith("image/")) {
        try {
          const imageResponse = await fetch(mediaUrl, {
            headers: {
              "Authorization": "Basic " + Buffer.from(
                `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
              ).toString("base64"),
            },
          });

          if (!imageResponse.ok) {
            throw new Error(`Failed to fetch image: ${imageResponse.status}`);
          }

          const imageBuffer = await imageResponse.arrayBuffer();
          const base64Image = Buffer.from(imageBuffer).toString("base64");

          const extractResponse = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1000,
            messages: [{
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: mediaType, data: base64Image },
                },
                {
                  type: "text",
                  text: `Extrae los datos de esta reserva de Airbnb y responde SOLO con un JSON válido con esta estructura exacta, sin texto adicional:
{
  "nombre": "nombre completo del huésped",
  "telefono": "número de teléfono con código de país sin espacios ni símbolos, o null si no aparece",
  "checkin": "fecha en formato YYYY-MM-DD",
  "checkout": "fecha en formato YYYY-MM-DD",
  "pax": número de huéspedes como integer,
  "notas": "cualquier nota relevante o cadena vacía"
}
Si no puedes extraer algún campo, usa null para strings y 0 para números.`,
                },
              ],
            }],
          });

          const extractedText = extractResponse.content[0].text.trim();
          let reservationData;

          try {
            reservationData = JSON.parse(extractedText);
          } catch (e) {
            const twiml = new MessagingResponse();
            twiml.message("No pude leer los datos de la reserva. Intenta con una imagen más clara.");
            return res.type("text/xml").send(twiml.toString());
          }

          if (reservationData.telefono) {
            saveGuestReservation(reservationData.telefono, reservationData);
            const twiml = new MessagingResponse();
            twiml.message(
              `✅ Reserva guardada exitosamente:\n\n` +
              `👤 ${reservationData.nombre}\n` +
              `📅 Check-in: ${reservationData.checkin}\n` +
              `📅 Checkout: ${reservationData.checkout}\n` +
              `👥 Huéspedes: ${reservationData.pax}\n` +
              `📝 ${reservationData.notas || "Sin notas"}`
            );
            return res.type("text/xml").send(twiml.toString());
          } else {
            const data = loadReservations();
            data.pending = reservationData;
            saveReservations(data);
            const twiml = new MessagingResponse();
            twiml.message(
              `⚠️ Reserva extraída pero sin número de teléfono:\n\n` +
              `👤 ${reservationData.nombre}\n` +
              `📅 Check-in: ${reservationData.checkin}\n` +
              `📅 Checkout: ${reservationData.checkout}\n\n` +
              `Responde con el número del huésped para guardarla:\n` +
              `Ej: guardar +56912345678`
            );
            return res.type("text/xml").send(twiml.toString());
          }
        } catch (err) {
          console.error("Error processing reservation image:", err.message);
          const twiml = new MessagingResponse();
          twiml.message("Error al procesar la imagen. Intenta nuevamente.");
          return res.type("text/xml").send(twiml.toString());
        }
      }

      // Comando: lista
      if (body.toLowerCase() === "lista") {
        const data = loadReservations();
        const keys  = Object.keys(data.reservations);
        if (keys.length === 0) {
          const twiml = new MessagingResponse();
          twiml.message("No hay reservas registradas actualmente.");
          return res.type("text/xml").send(twiml.toString());
        }
        const list = keys.map((k) => {
          const r = data.reservations[k];
          return `👤 ${r.nombre}\n📞 +${k}\n📅 ${r.checkin} → ${r.checkout}\n👥 ${r.pax} pax`;
        }).join("\n\n");
        const twiml = new MessagingResponse();
        twiml.message(`📋 Reservas activas:\n\n${list}`);
        return res.type("text/xml").send(twiml.toString());
      }

      // Comando: eliminar +56912345678
      if (body.toLowerCase().startsWith("eliminar ")) {
        const phoneToDelete = body.split(" ")[1].replace("+", "").replace(/\s/g, "");
        const data = loadReservations();
        if (data.reservations[phoneToDelete]) {
          const nombre = data.reservations[phoneToDelete].nombre;
          delete data.reservations[phoneToDelete];
          saveReservations(data);
          const twiml = new MessagingResponse();
          twiml.message(`🗑️ Reserva de ${nombre} eliminada.`);
          return res.type("text/xml").send(twiml.toString());
        } else {
          const twiml = new MessagingResponse();
          twiml.message("No encontré una reserva para ese número.");
          return res.type("text/xml").send(twiml.toString());
        }
      }

      // Comando: guardar +56912345678
      if (body.toLowerCase().startsWith("guardar ")) {
        const parts       = body.split(" ");
        const phoneToSave = parts[1].replace("+", "").replace(/\s/g, "");
        const data        = loadReservations();
        const pending     = data.pending;
        if (pending) {
          saveGuestReservation(phoneToSave, pending);
          delete data.pending;
          saveReservations(data);
          const twiml = new MessagingResponse();
          twiml.message(`✅ Reserva de ${pending.nombre} guardada para el número +${phoneToSave}`);
          return res.type("text/xml").send(twiml.toString());
        }
      }

      // Menú de comandos del anfitrión
      const twiml = new MessagingResponse();
      twiml.message(
        `Hola Esteban 👋\n\nComandos disponibles:\n\n` +
        `📸 Envía una captura de Airbnb para guardar una reserva\n` +
        `📋 Escribe "lista" para ver reservas activas\n` +
        `🗑️ Escribe "eliminar +56912345678" para borrar una reserva`
      );
      return res.type("text/xml").send(twiml.toString());
    }

    // ── FLUJO DEL HUÉSPED ──────────────────────────────────────────────────────

    // Contexto personalizado según reserva
    const guestReservation = getGuestReservation(from);
    let guestContext = "";
    if (guestReservation) {
      const today    = new Date().toISOString().split("T")[0];
      const daysLeft = Math.ceil((new Date(guestReservation.checkout) - new Date(today)) / (1000 * 60 * 60 * 24));
      guestContext =
        `\n\nCONTEXTO DEL HUÉSPED ACTUAL:\n` +
        `Nombre: ${guestReservation.nombre}\n` +
        `Check-in: ${guestReservation.checkin}\n` +
        `Checkout: ${guestReservation.checkout}\n` +
        `Días restantes: ${daysLeft}\n` +
        `Huéspedes: ${guestReservation.pax}\n` +
        `Notas: ${guestReservation.notas || "ninguna"}\n\n` +
        `Usa el nombre del huésped naturalmente en la conversación.\n` +
        `Si le quedan 0 días (hoy es su checkout), recuérdale amablemente el horario de salida.\n` +
        `Si le queda 1 día, menciona sutilmente que mañana es su último día.`;
    }

    const conv = getConversation(from);
    conv.messages.push({ role: "user", content: body });
    if (conv.messages.length > MAX_TURNS * 2) {
      conv.messages = conv.messages.slice(-MAX_TURNS * 2);
    }

    // Verificar keywords y alertar al host si corresponde
    await checkAndSendAlert(body, from);

    // Mensaje de "pensando"
    const thinkingMsg = THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)];
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: thinkingMsg,
    });

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT + (KNOWLEDGE_BASE ? "\n\n=== BASE DE CONOCIMIENTO ===\n" + KNOWLEDGE_BASE : "") + guestContext,
      messages: conv.messages,
    });

    const rawText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const { cleanText, imageKeys } = extractImageTags(rawText);
    conv.messages.push({ role: "assistant", content: cleanText });

    const twiml = new MessagingResponse();
    const msg   = twiml.message(cleanText);
    if (imageKeys.length > 0) {
      const imageUrl = IMAGE_BASE_URL + IMAGE_MAP[imageKeys[0]] + "?raw=true";
      msg.media(imageUrl);
    }

    return res.type("text/xml").send(twiml.toString());

  } catch (err) {
    console.error("Error al procesar mensaje:", err);
    const twiml = new MessagingResponse();
    twiml.message("Ocurrió un error. Por favor intenta de nuevo en un momento.");
    return res.type("text/xml").send(twiml.toString());
  }
});

// ─── RECORDATORIO DE CHECKOUT ─────────────────────────────────────────────────

const checkCheckouts = async () => {
  const today = new Date().toISOString().split("T")[0];
  const data  = loadReservations();

  for (const [phone, reservation] of Object.entries(data.reservations)) {
    if (reservation.checkout === today) {
      try {
        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: `whatsapp:+${phone}`,
          body:
            `Buenos días ${reservation.nombre} 🌅\n\n` +
            `Recuerda que hoy es tu día de checkout. El horario límite es las 12:00 hrs del mediodía.\n\n` +
            `Deja las llaves digitadas en 0000# para resetear y asegúrate de cerrar bien la puerta y ventanas.\n\n` +
            `¡Fue un placer tenerte en el Depto 611! Esperamos verte pronto en Santiago 🙏`,
        });
        console.log(`Checkout reminder sent to ${phone}`);

        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: HOST_WHATSAPP,
          body:
            `📅 CHECKOUT HOY — Depto 611\n\n` +
            `👤 ${reservation.nombre}\n` +
            `📞 +${phone}\n\n` +
            `Se envió recordatorio automático al huésped.`,
        });
      } catch (err) {
        console.error(`Error sending checkout reminder to ${phone}:`, err.message);
      }
    }
  }
};

// Verificar checkouts cada minuto, disparar solo a las 9:00 AM
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 9 && now.getMinutes() === 0) {
    await checkCheckouts();
  }
}, 60 * 1000);

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
