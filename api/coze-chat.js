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
  const patFingerprint = pat ? `...${pat.slice(-4)}` : "missing";

  try {
    console.log("Coze request config:", {
      botId,
      patFingerprint,
      userId,
      historyCount: additionalMessages.length
    });

    const cozeResponse = await fetch("https://api.coze.com/v3/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bot_id: botId,
        user_id: userId,
        stream: true,
        auto_save_history: false,
        additional_messages: additionalMessages
      })
    });

    const responseText = await cozeResponse.text();
    const fallbackReply = "Я помогаю только с вопросами по VADYA OFM CLUB: программа, тарифы, заявка и старт обучения. Если вопрос по теме, сформулируй его чуть точнее.";

    console.log("Coze response status:", cozeResponse.status);
    console.log("Coze raw response preview:", responseText.slice(0, 2000));

    if (!cozeResponse.ok) {
      console.log("Coze returned non-OK response, using fallback.");
      return res.status(cozeResponse.status || 502).json({
        reply: `${fallbackReply}\n\nТехническая ошибка Coze: ${responseText || "Coze request failed."}`,
        error: responseText || "Coze request failed."
      });
    }

    const reply = readCozeResponse(responseText);
    if (!reply) {
      console.log("Parsed reply is empty, using fallback.");
      return res.status(200).json({
        reply: `${fallbackReply}\n\nНе удалось разобрать ответ Coze: ${responseText}`,
        error: `Could not parse Coze reply: ${responseText}`
      });
    }

    console.log("Parsed reply:", reply);

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Unexpected error in /api/coze-chat:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
};

function readCozeResponse(rawText) {
  if (rawText.includes('event:')) {
    return readCozeStreamText(rawText);
  }

  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return "";
  }

  const candidates = collectReplyCandidates(payload);
  if (!candidates.length) {
    return "";
  }

  const best = candidates
    .map((text) => normalizeReply(text))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0];

  return best || "";
}

function readCozeStreamText(rawText) {
  const chunks = rawText.split("\n\n");
  const candidates = [];

  for (const chunk of chunks) {
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    let eventName = "";
    let dataLine = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim().toLowerCase();
      } else if (line.startsWith("data:")) {
        dataLine += line.slice(5).trim();
      }
    }

    if (!dataLine || dataLine === "[DONE]") continue;

    let payload;
    try {
      payload = JSON.parse(dataLine);
    } catch {
      continue;
    }

    if (isServiceEventName(eventName) || isServicePayload(payload)) continue;

    collectReplyCandidates(payload).forEach((text) => {
      if (text && !looksLikeServicePayload(text)) {
        candidates.push(text);
      }
    });
  }

  if (!candidates.length) return "";
  return normalizeReply(
    candidates
      .map((text) => normalizeReply(text))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || ""
  );
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

function collectReplyCandidates(root) {
  const results = [];
  const seen = new Set();

  function walk(value) {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);

      if (looksLikeServicePayload(trimmed)) {
        const parsed = parsePossiblyStringifiedJson(trimmed);
        if (parsed && typeof parsed === "object") walk(parsed);
        return;
      }

      results.push(trimmed);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === "object") {
      if (isServicePayload(value)) return;
      const orderedKeys = [
        "content",
        "answer",
        "reply",
        "output",
        "text",
        "message",
        "data",
        "messages"
      ];

      for (const key of orderedKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          walk(value[key]);
        }
      }

      for (const [key, nested] of Object.entries(value)) {
        if (orderedKeys.includes(key)) continue;
        walk(nested);
      }
    }
  }

  walk(root);
  return results.filter((text) => !looksLikeServicePayload(text));
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

function isServiceEventName(eventName) {
  if (!eventName) return false;
  return (
    eventName.includes("knowledge") ||
    eventName.includes("recall") ||
    eventName.includes("debug") ||
    eventName.includes("tool") ||
    eventName.includes("workflow") ||
    eventName.includes("generate_answer_finish") ||
    eventName.includes("message_finish") ||
    eventName.includes("finish")
  );
}

function normalizeReply(text) {
  return text
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])(?=\S)/g, "$1 ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
