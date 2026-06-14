import { Router } from "express";
import {
  retryAI,
  cleanCodeResponse,
  isAIConfigured,
} from "../utils/ollama.js";

const router = Router();

const LANGUAGE_ALIASES = {
  "c++": "cpp",
  cpp: "cpp",
  cplusplus: "cpp",
  "c plus plus": "cpp",
  c: "c",
  java: "java",
  py: "python",
  python: "python",
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  go: "go",
  golang: "go",
  rb: "ruby",
  ruby: "ruby",
  php: "php",
  kt: "kotlin",
  kotlin: "kotlin",
  sh: "bash",
  shell: "bash",
  bash: "bash",
};

const LANGUAGE_LABELS = {
  cpp: "C++",
  c: "C",
  java: "Java",
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  go: "Go",
  ruby: "Ruby",
  php: "PHP",
  kotlin: "Kotlin",
  bash: "Bash",
};

const STYLE_HINTS = {
  cpp: "Use #include <iostream>, using namespace std, cin, and cout.",
  c: "Use #include <stdio.h>, scanf, and printf.",
  java: "Use public class Main and public static void main(String[] args).",
  python: "Write Python 3 code.",
  javascript: "Write modern JavaScript runnable with Node.js.",
  typescript: "Write typed TypeScript runnable with tsx.",
  go: "Use package main and func main().",
  ruby: "Write Ruby code.",
  php: "Write PHP CLI code starting with <?php.",
  kotlin: "Write Kotlin code with fun main().",
  bash: "Write a Bash script.",
};

function normalizeLanguage(language = "cpp") {
  const lang = String(language).toLowerCase().trim();
  return LANGUAGE_ALIASES[lang] || "cpp";
}

function getLanguageLabel(language) {
  return LANGUAGE_LABELS[normalizeLanguage(language)] || "C++";
}

function getStyleHint(language) {
  const norm = normalizeLanguage(language);
  return STYLE_HINTS[norm] || `Write valid ${getLanguageLabel(language)} code.`;
}

function userAskedForComments(prompt = "") {
  return /\b(comment|comments|with comments|add comments|explain in code|add notes)\b/i.test(
    String(prompt),
  );
}

router.post("/fix-code", async (req, res) => {
  const { code, error = "", language = "cpp" } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Code is required" });
  }

  if (!isAIConfigured()) {
    return res.status(500).json({ error: "AI service not configured." });
  }

  const lang = normalizeLanguage(language);
  const langLabel = getLanguageLabel(lang);
  const hint = getStyleHint(lang);

  try {
    const prompt = `
Language: ${langLabel}

Task:
Fix the following code.

Requirements:
- Return ONLY corrected ${langLabel} code
- No markdown
- No explanation
- Keep original logic
- Do not rewrite unnecessarily
- Fix syntax errors
- Fix runtime bugs
- Fix memory issues
- Fix imports/includes
- Keep code compilable
- Keep beginner-friendly style
- Initialize variables properly
- Avoid undefined behavior

${hint}

${error ? `Compiler Error:\n${error}\n` : ""}

Code:
${code}

Before final answer:
- verify syntax
- verify imports
- verify recursion
- verify loops
- verify variable initialization
- verify memory safety
`;

    const raw = await retryAI(prompt);
    const fixedCode = cleanCodeResponse(raw);

    if (!fixedCode) {
      return res.status(502).json({ error: "AI returned an empty response." });
    }

    return res.json({ fixedCode });
  } catch (err) {
    console.error("AI Fix Error:", err);
    return res.status(500).json({
      error: "AI service error.",
    });
  }
});

router.post("/write-code", async (req, res) => {
  const { prompt: userPrompt, language = "cpp" } = req.body;

  if (!userPrompt || !String(userPrompt).trim()) {
    return res.status(400).json({ error: "Prompt is required" });
  }

  if (String(userPrompt).length > 1000) {
    return res.status(400).json({ error: "Prompt is too long (max 1000 characters)." });
  }

  if (!isAIConfigured()) {
    return res.status(500).json({ error: "AI service not configured." });
  }

  const lang = normalizeLanguage(language);
  const langLabel = getLanguageLabel(lang);
  const hint = getStyleHint(lang);
  const allowComments = userAskedForComments(userPrompt);

  try {
    const prompt = `
Language: ${langLabel}

Task:
${userPrompt}

Requirements:
- Return ONLY valid ${langLabel} code
- No markdown
- No explanation
- ${allowComments ? "Comments allowed." : "No comments."}
- Full runnable program
- Use proper syntax
- Use proper indentation
- Initialize variables
- Avoid runtime errors
- Avoid memory leaks
- Handle edge cases
- Use beginner-friendly logic
- Do not hallucinate libraries
- Do not add extra features
- If the task needs input, read it from standard input (stdin)

${hint}

Before final answer:
- verify syntax
- verify imports
- verify recursion
- verify loops
- verify variable initialization
- verify array bounds
`;

    const raw = await retryAI(prompt);
    const generatedCode = cleanCodeResponse(raw);

    if (!generatedCode) {
      return res.status(502).json({ error: "AI returned an empty response." });
    }

    return res.json({ code: generatedCode });
  } catch (err) {
    console.error("AI Write Error:", err);
    return res.status(500).json({
      error: "AI service error.",
    });
  }
});

export default router;
