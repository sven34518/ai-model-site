module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const pat = process.env.COZE_PAT;
  const botId = process.env.COZE_BOT_ID;

  if (!pat || !botId) {
    return res.status(500).json({
      error: "Missing COZE_PAT or COZE_BOT_ID in environment variables."
    });
  }

  const { message, history } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
  const additionalMessages = safeHistory
    .filter((item) => item && typeof item.content === "string" && item.content.trim())
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      type: item.role === "assistant" ? "answer" : "question",
      content_type: "text",
      content: item.content.trim()
    }));

  const userId =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.headers["x-real-ip"]?.toString() ||
    "anonymous-visitor";

  try {
    const cozeResponse = await fetch("https://api.coze.com/v3/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: userId,
        stream: false,
        auto_save_history: false,
        additional_messages: additionalMessages
      })
    });

    const responseText = await cozeResponse.text();
    const fallbackReply = "Сейчас я не смог получить точный ответ. Напишите владельцу в Telegram: @preludik.";

    if (!cozeResponse.ok) {
      return res.status(cozeResponse.status || 502).json({
        reply: fallbackReply,
        error: responseText || "Coze request failed."
      });
    }

    const reply = readCozeResponse(responseText);
    if (!reply) {
      return res.status(200).json({
        reply: fallbackReply,
        error: `Could not parse Coze reply: ${responseText}`
      });
    }

    return res.status(200).json({ reply });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
};

function readCozeResponse(rawText) {
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return "";
  }

  if (isServicePayload(payload)) {
    return "";
  }

  const directReply =
    extractVisibleText(payload.data) ||
    extractVisibleText(payload.message) ||
    extractVisibleText(payload);

  if (typeof directReply === "string" && directReply.trim()) {
    return normalizeReply(directReply);
  }

  const dataObject = parsePossiblyStringifiedJson(payload.data);
  if (dataObject && !isServicePayload(dataObject)) {
    const nestedReply =
      extractVisibleText(dataObject) ||
      extractVisibleText(dataObject.message) ||
      extractVisibleText(dataObject.data);
    if (nestedReply) return normalizeReply(nestedReply);
  }

  const messages = payload.data?.messages || payload.messages || [];
  if (Array.isArray(messages)) {
    for (const item of messages) {
      const candidate = extractVisibleText(item);
      if (candidate) return normalizeReply(candidate);
    }
  }

  return "";
}

function parsePossiblyStringifiedJson(value) {
  if (typeof value !== "string") return value && typeof value === "object" ? value : null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractVisibleText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload.content,
    payload.answer,
    payload.reply,
    payload.output,
    payload.text,
    payload.message?.content,
    payload.data?.content,
    payload.data?.message?.content,
    payload.data?.answer,
    payload.data?.reply,
    payload.data?.output,
    payload.data?.text
  ];

  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (looksLikeServicePayload(trimmed)) continue;
    return trimmed;
  }

  return "";
}

function looksLikeServicePayload(text) {
  if (!text.startsWith("{")) return false;

  try {
    const parsed = JSON.parse(text);
    const msgType =
      parsed?.msg_type ||
      parsed?.type ||
      parsed?.event ||
      parsed?.message?.type ||
      parsed?.data?.type ||
      "";

    if (typeof msgType === "string") {
      const normalizedType = msgType.toLowerCase();
      return (
        normalizedType.includes("knowledge") ||
        normalizedType.includes("recall") ||
        normalizedType.includes("debug") ||
        normalizedType.includes("tool") ||
        normalizedType.includes("workflow") ||
        normalizedType.includes("generate_answer_finish") ||
        normalizedType.includes("message_finish")
      );
    }

    return Boolean(parsed?.chunks || parsed?.ori_req || parsed?.status_code !== undefined);
  } catch {
    return false;
  }
}

function isServicePayload(payload) {
  if (!payload || typeof payload !== "object") return false;

  const msgType = String(
    payload.msg_type ||
    payload.type ||
    payload.event ||
    payload.message?.type ||
    payload.data?.type ||
    ""
  ).toLowerCase();

  if (
    msgType.includes("knowledge") ||
    msgType.includes("recall") ||
    msgType.includes("debug") ||
    msgType.includes("tool") ||
    msgType.includes("workflow") ||
    msgType.includes("generate_answer_finish") ||
    msgType.includes("message_finish")
  ) {
    return true;
  }

  const dataText = typeof payload.data === "string" ? payload.data : "";
  if (dataText && looksLikeServicePayload(dataText)) return true;

  return Boolean(
    payload.finish_reason !== undefined ||
    payload.FinData !== undefined ||
    payload.ori_req !== undefined
  );
}

function normalizeReply(text) {
  return text
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])(?=\S)/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
