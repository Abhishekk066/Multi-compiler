import crypto from "crypto";
import { Router } from "express";
import fetch from "node-fetch";
import QRCode from "qrcode";

function generateShortId(length = 8) {
  return crypto
    .randomBytes(Math.ceil((length * 3) / 4))
    .toString("base64url")
    .slice(0, length);
}

const mainDomain =
  process.env.MAIN_DOMAIN || "https://compiler.abhishekdev.cloud";
const requestedDomain =
  process.env.REQUESTED_DOMAIN || "https://fecpp.abhishekdev.cloud";

const DEFAULT_CODES = {
  cpp: {
    filename: "main.cpp",
    code: `#include <iostream>
using namespace std;

int main() {
    string name;
    cout << "Enter your name: ";
    cin >> name;
    cout << "Hello, " << name;
    return 0;
}`,
  },
  c: {
    filename: "main.c",
    code: `#include <stdio.h>

int main() {
    char name[100];
    printf("Enter your name: ");
    scanf("%99s", name);
    printf("Hello, %s", name);
    return 0;
}`,
  },
  java: {
    filename: "Main.java",
    code: `import java.util.Scanner;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        System.out.print("Enter your name: ");
        String name = sc.nextLine();
        System.out.print("Hello, " + name);
        sc.close();
    }
}`,
  },
  python: {
    filename: "main.py",
    code: `name = input("Enter your name: ")
print(f"Hello, {name}")`,
  },
  javascript: {
    filename: "main.js",
    code: `const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Enter your name: ', (name) => {
    console.log('Hello, ' + name);
    rl.close();
});`,
  },
  typescript: {
    filename: "main.ts",
    code: `import * as readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Enter your name: ', (name: string) => {
    console.log('Hello, ' + name);
    rl.close();
});`,
  },
  go: {
    filename: "main.go",
    code: `package main

import "fmt"

func main() {
    var name string
    fmt.Print("Enter your name: ")
    fmt.Scan(&name)
    fmt.Print("Hello, " + name)
}`,
  },
  ruby: {
    filename: "main.rb",
    code: `print "Enter your name: "
name = gets.chomp
print "Hello, #{name}"`,
  },
  php: {
    filename: "main.php",
    code: `<?php
echo "Enter your name: ";
$name = trim(fgets(STDIN));
echo "Hello, " . $name;
?>`,
  },
  kotlin: {
    filename: "main.kt",
    code: `fun main() {
    print("Enter your name: ")
    val name = readLine() ?: ""
    print("Hello, $name")
}`,
  },
  bash: {
    filename: "main.sh",
    code: `#!/bin/bash
read -p "Enter your name: " name
printf "Hello, %s" "$name"`,
  },

  rust: {
    filename: "main.rs",
    code: `use std::io::{self, Write};

fn main() {
    print!("Enter your name: ");
    io::stdout().flush().unwrap();
    let mut name = String::new();
    io::stdin().read_line(&mut name).unwrap();
    let name = name.trim();
    print!("Hello, {}", name);
}`,
  },

  csharp: {
    filename: "main.cs",
    code: `using System;

class Program {
    static void Main(string[] args) {
        Console.Write("Enter your name: ");
        string name = Console.ReadLine();
        Console.Write("Hello, " + name);
    }
}`,
  },

  perl: {
    filename: "main.pl",
    code: `print "Enter your name: ";
chomp(my $name = <STDIN>);
print "Hello, $name";`,
  },

  lua: {
    filename: "main.lua",
    code: `io.write("Enter your name: ")
io.flush()
local name = io.read()
io.write("Hello, " .. name)`,
  },

  r: {
    filename: "main.r",
    code: `con <- file("stdin", open = "r")
cat("Enter your name: ")
name <- readLines(con, n = 1)
cat("Hello,", name)
close(con)`,
  },

  html: {
    filename: "index.html",
    code: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hello</title>
</head>
<body>
  <h1>Hello, World!</h1>
  <p>Welcome to HTML.</p>
</body>
</html>`,
  },

  sql: {
    filename: "main.sql",
    code: `DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  age  INT
);

INSERT INTO users (name, age) VALUES ('Alice', 30);
INSERT INTO users (name, age) VALUES ('Bob', 25);
INSERT INTO users (name, age) VALUES ('Charlie', 35);

DESC users;

SELECT * FROM users;
SELECT name FROM users WHERE age > 28 ORDER BY name ASC;

DROP TABLE users;`,
  },
};

function normalizeLanguage(language = "cpp") {
  const lang = String(language).toLowerCase().trim();

  const aliases = {
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

    rs: "rust",
    rust: "rust",

    cs: "csharp",
    csharp: "csharp",
    "c#": "csharp",
    dotnet: "csharp",

    pl: "perl",
    perl: "perl",

    lua: "lua",

    r: "r",
    rscript: "r",

    html: "html",
    htm: "html",

    sql: "sql",
    mysql: "sql",
    sqlite: "sql",
  };

  return aliases[lang] || "cpp";
}

function getBaseUrl(req) {
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto || req.protocol || "https";
  const host = req.get("host");

  if (!host) return mainDomain;

  return `${protocol}://${host}`;
}

function sendCachedCode(req, res, codeCache) {
  const codeId = req.params.id;
  const code = codeCache.get(codeId);

  if (!code) {
    return res
      .status(404)
      .send("<script>window.location.replace('/');</script>");
  }

  return res.json(code);
}

/**
 * Create the code routes router.
 * @param {import('node-cache')} codeCache
 */
export default function createCodeRouter(codeCache) {
  const router = Router();

  router.post("/generate-url", async (req, res) => {
    const { code, filename, language } = req.body;

    if (!code) {
      return res.status(400).json({ error: "Code is required" });
    }

    const normalizedLanguage = normalizeLanguage(language);

    const safeFilename =
      (filename || DEFAULT_CODES[normalizedLanguage]?.filename || "main.cpp")
        .replace(/[^a-zA-Z0-9._-]/g, "")
        .slice(0, 100) || "main.cpp";

    const data = {
      message: true,
      type: "default",
      filename: safeFilename,
      code,
      language: normalizedLanguage,
    };

    const codeId = generateShortId();
    codeCache.set(codeId, data);

    const route = `/share/${codeId}`;
    const url = `${getBaseUrl(req)}${route}`;

    return res.status(200).json({
      message: true,
      url,
      id: codeId,
    });
  });

  router.post("/generate-qrcode", async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "Invalid URL" });
      }
      const qrcodeUrl = await QRCode.toDataURL(url, { margin: 2 });

      return res.status(200).json({
        message: true,
        qrcodeUrl,
      });
    } catch (err) {
      console.error("QR Code Error:", err);

      return res.status(500).json({
        message: false,
        error: "Failed to generate QR code",
      });
    }
  });

  router.post("/send-url", async (req, res) => {
    const fetchUrl = `${requestedDomain}/send-code`;

    try {
      const response = await fetch(fetchUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body || {}),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const data = await response.json();

      if (!data.message) {
        return res.status(404).json({ message: false });
      }

      const normalizedLanguage = normalizeLanguage(data.language);

      const cachedData = {
        ...data,
        language: normalizedLanguage,
      };

      const codeId = generateShortId();
      codeCache.set(codeId, cachedData);

      const route = `/c/${codeId}`;
      const url = `${mainDomain}${route}`;

      return res.status(200).json({
        message: true,
        url,
        id: codeId,
      });
    } catch (error) {
      console.error("Send URL Error:", error);

      return res.status(500).json({
        message: false,
        error: "Failed to fetch code from external service",
      });
    }
  });

  router.get("/code/c/:id", (req, res) => {
    return sendCachedCode(req, res, codeCache);
  });

  router.post("/code/c/:id", (req, res) => {
    return sendCachedCode(req, res, codeCache);
  });

  router.get("/code/share/:id", (req, res) => {
    return sendCachedCode(req, res, codeCache);
  });

  router.post("/code/share/:id", (req, res) => {
    return sendCachedCode(req, res, codeCache);
  });

  router.post("/default-code", async (req, res) => {
    try {
      const lang = normalizeLanguage(
        req.body?.language || req.query?.lang || "cpp",
      );
      const entry = DEFAULT_CODES[lang] || DEFAULT_CODES.cpp;

      return res.json({
        type: "default",
        language: lang,
        filename: entry.filename,
        code: entry.code,
      });
    } catch (error) {
      console.error("Default Code Error:", error);

      return res.status(500).json({
        error: "Failed to fetch default code",
      });
    }
  });

  router.get("/default-code", async (req, res) => {
    try {
      const lang = normalizeLanguage(
        req.query?.lang || req.query?.language || "cpp",
      );
      const entry = DEFAULT_CODES[lang] || DEFAULT_CODES.cpp;

      return res.json({
        type: "default",
        language: lang,
        filename: entry.filename,
        code: entry.code,
      });
    } catch (error) {
      console.error("Default Code Error:", error);

      return res.status(500).json({
        error: "Failed to fetch default code",
      });
    }
  });

  router.get("/languages", (_req, res) => {
    const list = Object.entries(DEFAULT_CODES).map(([key, val]) => ({
      key,
      filename: val.filename,
    }));

    return res.json({ languages: list });
  });

  return router;
}
