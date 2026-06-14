import { Ollama } from "ollama";

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://187.127.130.72:11434";

const client = new Ollama({
  host: OLLAMA_HOST,
});

const SYSTEM_PROMPT = `
You are a senior software engineer.

Rules:
- Always generate correct and compilable code
- Never output markdown
- Never explain code
- Return ONLY source code
- Avoid syntax errors
- Avoid memory leaks
- Avoid undefined variables
- Use beginner-friendly logic
- Check edge cases before answering
- Ensure recursion has correct base condition
- Ensure imports/includes are valid
- Ensure all variables are initialized
- Never hallucinate APIs
- Complete the full program
- Keep output deterministic
`;

export async function callAI(prompt) {
  if (!prompt || typeof prompt !== "string") {
    throw new Error("Prompt is required");
  }

  try {
    const response = await Promise.race([
      client.chat({
        model: OLLAMA_MODEL,

        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },

          {
            role: "user",
            content: prompt,
          },
        ],

        stream: false,

        options: {
          temperature: 0,
          top_p: 0.8,
          top_k: 20,
          repeat_penalty: 1.05,
          num_ctx: 4096,
          num_predict: 900,
          seed: 42,
        },
      }),

      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI request timeout")), 60000),
      ),
    ]);

    const content = response?.message?.content?.trim() || "";

    return cleanCodeResponse(content);
  } catch (err) {
    console.error("OLLAMA ERROR:", err);
    throw err;
  }
}

export async function retryAI(prompt, retries = 2) {
  let lastError;

  for (let i = 0; i <= retries; i++) {
    try {
      const result = await callAI(prompt);

      if (result && result.length > 20) {
        return result;
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("AI generation failed");
}

export function isAIConfigured() {
  return Boolean(OLLAMA_HOST && OLLAMA_MODEL);
}

export function cleanCodeResponse(response) {
  if (!response) return "";

  let code = String(response).trim();

  const fenceMatch = code.match(/```(?:[\w+-]+)?\s*([\s\S]*?)```/);

  if (fenceMatch) {
    code = fenceMatch[1].trim();
  }

  code = code
    .replace(/^```[\w+-]*\s*/gi, "")
    .replace(/```$/gi, "")
    .trim();

  code = code.replace(/^```[\w-]*\n?/gm, "");
  code = code.replace(/```$/gm, "");

  const removeLines = [
    /^Here(?:'s| is).*$/gim,
    /^Sure.*$/gim,
    /^Of course.*$/gim,
    /^Explanation:.*$/gim,
    /^Note:.*$/gim,
    /^Output:.*$/gim,
  ];

  for (const pattern of removeLines) {
    code = code.replace(pattern, "");
  }

  return code.trim();
}
