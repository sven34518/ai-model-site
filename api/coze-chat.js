module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const pat = process.env.COZE_PAT;
  const botId = process.env.COZE_BOT_ID;

  if (!pat || !botId) {
    console.error("Missing env vars", {
      hasPat: Boolean(pat),
      hasBotId: Boolean(botId)
    });
    return res.status(500).json({
      error: "Missing COZE_PAT or COZE_BOT_ID in environment variables."
    });
  }

  const { message } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const userId =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.headers["x-real-ip"]?.toString() ||
    "anonymous-visitor";

  const payload = {
    bot_id: botId,
    user_id: userId,
    stream: true,
    auto_save_history: false,
    additional_messages: [
      {
        role: "user",
        type: "question",
        content_type: "text",
        content: message.trim()
      }
    ]
  };

  try {
    console.log("Sending request to Coze", {
      botId,
      userId,
      payloadPreview: payload
    });

    const cozeResponse = await fetch("https://api.coze.com/v3/chat", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await cozeResponse.text();

    console.log("Coze raw response status", cozeResponse.status);
    console.log("Coze raw response body", responseText);

    if (!cozeResponse.ok) {
      return res.status(502).json({
        error: `Coze request failed: ${responseText}`
      });
    }

    const reply = extractReplyFromSSE(responseText);

    if (!reply) {
      return res.status(502).json({
        error: `Could not parse Coze reply: ${responseText}`
      });
    }

    return res.status(200).json({ reply });
  } catch (error) {
    console.error("Server error in /api/coze-chat", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown server error."
    });
  }
};

function extractReplyFromSSE(text) {
  const chunks = text.split("\n\n");
  let fullReply = "";
  let lastEvent = "";

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

    const candidate =
      payload.content ||
      payload.message?.content ||
      payload.data?.content ||
      payload.data?.message?.content ||
      "";

    if (!candidate) continue;

    if (lastEvent.includes("delta")) {
      fullReply += candidate;
    } else if (!fullReply) {
      fullReply = candidate;
    }
  }

  return fullReply.trim();
}
