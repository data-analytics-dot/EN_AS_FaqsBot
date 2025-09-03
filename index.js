import pkg from "@slack/bolt";
const { App } = pkg;
import OpenAI from "openai";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// --- Slack Bolt app (Socket Mode) ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// --- OpenAI setup ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Column map cache ---
let columnMap = {};

// ---------- Minimal Canvas formatter that preserves ordered numbering ----------
function extractText(node) {
  if (!node) return "";

  // Plain string
  if (typeof node === "string") return node;

  // Segments (sometimes Canvas splits text)
  if (Array.isArray(node.segments)) {
    return node.segments.map(s => {
      if (s.link) return `<${s.link}|${s.text || s.link}>`; // Slack hyperlink
      return s.text || "";
    }).join("");
  }

  // Spans (links often live here)
  if (Array.isArray(node.spans)) {
    return node.spans.map(s => {
      if (s.link) return `<${s.link}|${s.text || s.link}>`; // Slack hyperlink
      return s.text || "";
    }).join("");
  }

  // Fallback
  return node.text || "";
}

function formatBlocks(blocks, depth = 0) {
  const lines = [];
  const indent = "  ".repeat(depth);
  

  if (!Array.isArray(blocks)) return "";

  for (const block of blocks) {
    if (!block) continue;
    const type = (block.type || "").toLowerCase();

    if (Array.isArray(block.items) && block.items.length > 0) {
      const ordered =
        block.ordered === true ||
        block.listType === "numbered" ||
        type.includes("number") ||
        type.includes("ordered");

      let idx = 1;
      for (const item of block.items) {
        const itemText = extractText(item) || "";

        const prefix = ordered ? `${idx}.` : "•";
        lines.push(`${indent}${prefix} ${itemText.trim()}`);

        const nested =
          (Array.isArray(item.items) && item.items.length && [{ type: "list", items: item.items, ordered: item.ordered }]) ||
          (Array.isArray(item.content) && item.content) ||
          (Array.isArray(item.children) && item.children) ||
          [];

        if (nested && nested.length) {
          lines.push(formatBlocks(Array.isArray(nested) ? nested : [nested], depth + 1));
        }
        idx++;
      }
      continue;
    }

    if (type.includes("listitem") || block.listItem === true) {
      const itemText = extractText(block) || "";
      lines.push(`${indent}• ${itemText.trim()}`);
      if (Array.isArray(block.content) && block.content.length) {
        lines.push(formatBlocks(block.content, depth + 1));
      }
      continue;
    }

    if (type.includes("list") && Array.isArray(block.content) && block.content.length) {
      const ordered = block.listType === "numbered" || block.ordered === true || type.includes("numbered");
      let idx = 1;
      for (const item of block.content) {
        const itemText = extractText(item) || (Array.isArray(item.content) ? item.content.map(extractText).join(" ") : "");
        const prefix = ordered ? `${idx}.` : "•";
        lines.push(`${indent}${prefix} ${itemText.trim()}`);
        if (Array.isArray(item.content) && item.content.length) {
          lines.push(formatBlocks(item.content, depth + 1));
        }
        idx++;
      }
      continue;
    }

   if (type === "paragraph" || type === "text" || type.startsWith("heading") || !type) {
  // Instead of just extractText(block)
  const t = formatBlocks([...(block.content || block.children || [block])], depth).trim();
  if (t) lines.push(`${indent}${t}`);
  continue;
}



    if (Array.isArray(block.content) && block.content.length) {
      lines.push(formatBlocks(block.content, depth));
      continue;
    }
    if (Array.isArray(block.children) && block.children.length) {
      lines.push(formatBlocks(block.children, depth));
      continue;
    }

    const t = extractText(block).trim();
    if (t) lines.push(`${indent}${t}`);
  }

  return lines
    .flat()
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatCanvasContent(canvas) {
  let text = formatBlocks(canvas || []);
  const links = [];

  function scanBlocks(blocks) {
    for (const block of blocks) {
      if (!block) continue;

      // Check spans
      if (Array.isArray(block.spans)) {
        block.spans.forEach(s => {
          if (s.link) links.push(`<${s.link}|${s.text || s.link}>`);
        });
      }

      // Check segments
      if (Array.isArray(block.segments)) {
        block.segments.forEach(s => {
          if (s.link) links.push(`<${s.link}|${s.text || s.link}>`);
        });
      }

      // Recursively scan nested content
      const nested = [
        ...(Array.isArray(block.content) ? block.content : []),
        ...(Array.isArray(block.children) ? block.children : []),
        ...(Array.isArray(block.items) ? block.items : [])
      ];

      if (nested.length) scanBlocks(nested);
    }
  }

  scanBlocks(canvas);

  if (links.length) {
    text += "\n\nLink Tags:\n" + links.join("\n");
  }

  return text;
}

// --- Load column map once ---
async function getColumnMap() {
  const url = `https://coda.io/apis/v1/docs/${process.env.CODA_DOC_ID}/tables/${process.env.CODA_FAQ_TABLE_ID}/columns`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CODA_API_KEY}` },
  });
  const data = await res.json();

  columnMap = {};
  for (const col of data.items) {
    columnMap[col.id] = col.name;
  }
  console.log("📌 Column map loaded:", columnMap);
}

function formatAsSteps(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  let step = 1;
  let lastWasColon = false;

  const formatted = lines.map(line => {
    if (/^(For |Here|Step|Guide)/i.test(line)) {
      lastWasColon = false;
      return `\n*${line}*`;
    }

    if (lastWasColon) {
      lastWasColon = /:$/.test(line);
      return `      • ${line}`;
    }

    if (/^(If|When|Then|Else|Otherwise|Note)/i.test(line)) {
      lastWasColon = /:$/.test(line);
      return `   • ${line}`;
    }

    let result = `${step++}. ${line}`;
    lastWasColon = /:$/.test(line);
    return result;
  });

  return formatted.join("\n");
}

// --- Coda FAQ fetcher ---
async function getFAQs() {
  const url = `https://coda.io/apis/v1/docs/${process.env.CODA_DOC_ID}/tables/${process.env.CODA_FAQ_TABLE_ID}/rows`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CODA_API_KEY}` },
  });
  const data = await res.json();

  if (!data.items || !Array.isArray(data.items)) return []; // safety check

  const faqs = data.items.map(row => {
    let question = "";
    let answer = "";
    let link = "";

    for (const [colId, value] of Object.entries(row.values)) {
      const colName = columnMap[colId];
      if (colName === "Question") question = value;

      if (colName === "Next Step") {
        if (typeof value === "string") {
          answer = formatAsSteps(value);
        } else if (value?.type === "canvas") {
          answer = formatCanvasContent(value.document || []);
        }
      }

      if (colName === "Link") { 
        link = value;
      }
    }

    return { q: question, a: answer || "[No answer provided]", link: link || null  };
  });

  console.log("📖 Loaded FAQs:");
  faqs.forEach(f => { console.log("Q:", f.q, "| A:", f.a.substring(0, 100) + "...", "| Link:", f.link || "[No link]");});
  return faqs;
}


// --- Keyword matching ---
function keywordMatch(query, faqs) {
  let best = null, maxOverlap = 0;
  const qWords = query.toLowerCase().split(/\W+/).filter(Boolean);

  for (const faq of faqs) {
    if (!faq.q) continue;
    const faqWords = faq.q.toLowerCase().split(/\W+/).filter(Boolean);
    const overlap = qWords.filter(w => faqWords.includes(w)).length;

    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      best = faq;
    }
  }

  return maxOverlap > 0 ? { ...best } : null;
}

// --- Hybrid FAQ finder ---
async function findFAQ(query) {
  const faqs = await getFAQs();
  const keywordResult = keywordMatch(query, faqs);
  if (keywordResult) return keywordResult;

  const listForGPT = faqs
    .map((f, i) => `${i + 1}. Q: ${f.q}\n   A (snippet): ${f.a.slice(0, 200).replace(/\n/g,' ')}${f.a.length > 200 ? "..." : ""}`)
    .join("\n\n");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are an FAQ assistant. Pick the single most relevant FAQ from the list. Reply ONLY with the number. If nothing fits, reply 'none'.",
      },
      {
        role: "user",
        content: `User question: "${query}"\n\nFAQs:\n${listForGPT}\n\nWhich FAQ best matches? Reply with the number or 'none'.`,
      },
    ],
    max_tokens: 10,
  });

  const choice = response.choices[0].message.content.trim().toLowerCase();
  const m = choice.match(/\d+/);
  if (!m) return null;

  const idx = parseInt(m[0], 10) - 1;
  if (!faqs[idx]) return null;

  return { ...faqs[idx] }; // no debug

}

async function logQuestionToCoda({ user, question, timestamp, matchedFAQ, matchedFAQText}) {
  const docIdlog = process.env.CODA_LOG_DOC_ID;
  const tableIdlog = process.env.CODA_LOG_TABLE_ID;
  const apiToken = process.env.CODA_API_KEY;

  const body = {
    rows: [
      {
        cells: [
          { column: "c-5NLSZ-CJoZ", value: user },
          { column: "c-k8mJmPQwJY", value: question },
          { column: "c-BDM2hZ0kFL", value: timestamp },
          { column: "c-mwPZh6CxDE", value: matchedFAQ || "N/A" },
          { column: "c-NuAFM_I-ao", value: matchedFAQText }
        ]
      }
    ]
  };

  await fetch(`https://coda.io/apis/v1/docs/${docIdlog}/tables/${tableIdlog}/rows`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

// --- Handle mentions ---
app.event("app_mention", async ({ event, say }) => {
  const query = event.text.replace(/<@[^>]+>/, "").trim();
  const faq = await findFAQ(query);

  if (!faq) {
    await say(":question: Sorry, I couldn’t find a relevant FAQ.");
    return;
  }

  // Intro/outro phrases
  const introPhrases = [
    "Here’s what I found for you",
    "Got it! Let’s walk through the steps:",
    "No worries, I’ve got you covered. Try this:",
    "Alright, here’s how you can handle it:",
    "Let’s go step by step 🚀"
  ];

  const outroPhrases = [
    "Hope that helps!",
    "Let me know if you need more details"
  ];

  const intro = introPhrases[Math.floor(Math.random() * introPhrases.length)];
  const outro = outroPhrases[Math.floor(Math.random() * outroPhrases.length)];

  // --- GPT rewrite for human support style ---
  const chatResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a friendly but professional support agent.  
Use the provided FAQ content as your knowledge, but do NOT copy it verbatim.  
Write responses in short, conversational paragraphs—not lists or bullet points.  

Guidelines:
- Keep the tone natural, approachable, and professional.  
- Avoid exaggerated empathy or filler lines (e.g., “you’re not alone” or “I’m here to help however I can”).  
- Provide the answer directly, keeping it concise and actionable.  
- If needed, include conditional instructions (e.g., AI vs OPS project).  
- If the issue cannot be fully resolved with the given steps, suggest contacting the support team.  

Always end with a clear next step or pointer.
`
      },
      {
        role: "user",
        content: `User question: "${query}"
FAQ answer (knowledge base): ${faq.a}`
      }
    ],
    max_tokens: 300,
  });

  let gptAnswer = chatResponse.choices[0].message.content.trim();

  // --- Slack-friendly formatting ---
// --- Slack-friendly formatting while preserving numbers and links ---
// --- Slack-friendly formatting for plain paragraphs with links ---
gptAnswer = gptAnswer
  // Remove any leftover numbering or bullets
  .replace(/^\d+\.\s+/gm, '')
  .replace(/^- /gm, '')
  // Slack-style bold
  .replace(/\*\*(.*?)\*\*/g, '*$1*')
  // Collapse multiple newlines to a single newline
  .replace(/\n{2,}/g, '\n\n')
  // Trim whitespace on each line
  .split('\n').map(l => l.trim()).join('\n');




// Split into paragraphs
const paragraphs = gptAnswer.split("\n").filter(p => p.trim());

// Create Slack blocks
const blocks = [];

// Intro block
/*blocks.push({
  type: "section",
  text: { type: "mrkdwn", text: `${intro}` }
});*/

// Paragraph blocks
for (const p of paragraphs) {
  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: p }
  });
}

// Outro block
blocks.push({
  type: "section",
  text: { type: "mrkdwn", text: `_${outro}_` }
});

  if (faq.link) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:link: To view the full FAQ and related links, open this: <${faq.link}|${faq.q}>`
      }
    });
  }

// Add debug info if enabled
if (process.env.DEBUG_MODE === "true" && faq.debug) {
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `🔍 ${faq.debug}` }],
  });
}
 const userInfo = await app.client.users.info({
    token: process.env.SLACK_BOT_TOKEN,
    user: event.user
  });
  
const fullName = userInfo.user.profile.real_name;


await logQuestionToCoda({
    user: fullName,
    question: query,
    timestamp: new Date().toISOString(),
    matchedFAQ: faq ? faq.link : null,
    matchedFAQText: faq.q
  });

await say({
  text: gptAnswer,
  blocks,
  thread_ts: event.ts
  });
});


// --- Start app ---
(async () => {
  await getColumnMap(); // preload column map
  await app.start(process.env.PORT || 3000);
  console.log("⚡️ FAQ bot is running in Socket Mode!");
})();
