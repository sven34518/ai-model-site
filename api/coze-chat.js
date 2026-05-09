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
        stream: true,
        auto_save_history: false,
        additional_messages: additionalMessages
      })
    });

    if (!cozeResponse.ok || !cozeResponse.body) {
      const errorText = await cozeResponse.text();
      return res.status(cozeResponse.status || 502).json({
        error: errorText || "Coze request failed."
      });
    }

    const reply = await readCozeStream(cozeResponse.body);
    if (!reply) {
      return res.status(502).json({ error: "Empty response from Coze." });
    }

    return res.status(200).json({ reply });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
};

async function readCozeStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullReply = "";
  let lastEvent = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const lines = chunk
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          lastEvent = line.slice(6).trim();
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

      const msgType =
        payload.msg_type ||
        payload.type ||
        payload.event ||
        payload.message?.type ||
        payload.data?.type ||
        "";

      if (typeof msgType === "string") {
        const normalizedType = msgType.toLowerCase();
        if (
          normalizedType.includes("knowledge") ||
          normalizedType.includes("recall") ||
          normalizedType.includes("debug") ||
          normalizedType.includes("tool") ||
          normalizedType.includes("workflow")
        ) {
          continue;
        }
      }

      const candidate = extractVisibleText(payload);

      if (!candidate) continue;

      if (lastEvent.includes("delta")) {
  if (!fullReply) {
    fullReply = candidate;
  } else {
    const needSpace =
      !fullReply.endsWith(" ") &&
      !candidate.startsWith(" ") &&
      !/[.,!?;:)]$/.test(fullReply) &&
      !/^[.,!?;:)]/.test(candidate);

    fullReply += needSpace ? ` ${candidate}` : candidate;
  }
} else if (!fullReply) {
  fullReply = candidate;
}
    }
  }

  return fullReply.trim();
}

function extractVisibleText(payload) {
  const candidates = [
    payload.content,
    payload.message?.content,
    payload.data?.content,
    payload.data?.message?.content
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
        normalizedType.includes("workflow")
      );
    }

    return Boolean(parsed?.chunks || parsed?.ori_req || parsed?.status_code !== undefined);
  } catch {
    return false;
  }
}
