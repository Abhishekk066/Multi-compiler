// Fetch polyfill source once at startup so it can be inlined into blob iframes
// without depending on cross-origin <script src> loading (which has timing issues).
let _polySrc = "";
fetch("/poly-storage.js")
  .then(function (r) { return r.text(); })
  .then(function (t) { _polySrc = t; })
  .catch(function () {});

async function init() {
  const webSocketType =
    window.location.protocol === "https:"
      ? `wss://${window.location.host}`
      : `ws://${window.location.host}`;
  let socket;
  let reconnectAttempts = 0;
  const maxReconnectDelay = 10000;

  function connectWebSocket() {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
    }
    socket = new WebSocket(webSocketType);

    socket.onopen = () => {
      reconnectAttempts = 0;
      const statusElement = document.querySelector(
        ".status-item:nth-child(2) span",
      );
      if (statusElement) {
        statusElement.textContent = "Connected";
        statusElement.style.color = "";
      }
    };

    socket.onmessage = handleSocketMessage;
    socket.onerror = handleSocketError;
    socket.onclose = handleSocketClose;
  }
  connectWebSocket();

  const editorContainer = document.getElementById("editorContainer");
  const outputContainer = document.getElementById("outputContainer");
  const outputElement = document.getElementById("output");
  const toggleViewBtn = document.getElementById("toggle-view");
  const fileNameEditor = document.querySelector(".truncate");
  const outputBtn = document.querySelector(".output-btn");
  const fullEditor = document.querySelector(".file-name");

  if (!editorContainer || !outputContainer || !outputElement) {
    console.error("Required compiler layout elements are missing.");
    return;
  }

  let editorView = 0;
  let editor;
  let term;
  let inputBuffer = "";
  let isRunning = false;
  let lastCompileError = "";
  let currentRunId = null;
  let sqlOutputBuffer = "";

  const darkTerminalTheme = {
    background: "#030303",
    foreground: "#f5f5f5",
    cursor: "#f5f5f5",
    selectionBackground: "rgba(255, 255, 255, 0.3)",
  };

  const lightTerminalTheme = {
    background: "#ffffff",
    foreground: "#0f0f0f",
    cursor: "#0f0f0f",
    selectionBackground: "rgba(0, 80, 200, 0.25)",
  };

  term = new Terminal({
    theme: darkTerminalTheme,
    cursorBlink: true,
    disableStdin: true,
    rows: 30,
    fontFamily: "monospace",
    fontSize: 13,
    letterSpacing: 0.5,
    lineHeight: 1.5,
    cursorStyle: "bar",
    convertEol: true,
    scrollback: 5000,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(outputElement);

  function measureTerminalCell() {
    const terminalRows = outputElement.querySelector(".xterm-rows");
    const sourceStyle = window.getComputedStyle(terminalRows || outputElement);
    const probe = document.createElement("span");

    probe.textContent = "W".repeat(100);
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontFamily = sourceStyle.fontFamily || "monospace";
    probe.style.fontSize = sourceStyle.fontSize || `${term.options.fontSize}px`;
    probe.style.fontWeight = sourceStyle.fontWeight || "normal";
    probe.style.letterSpacing = sourceStyle.letterSpacing || "0px";
    probe.style.lineHeight =
      sourceStyle.lineHeight === "normal"
        ? `${term.options.fontSize * term.options.lineHeight}px`
        : sourceStyle.lineHeight;

    outputElement.appendChild(probe);

    const rect = probe.getBoundingClientRect();
    const renderedRow = outputElement.querySelector(".xterm-rows > div");
    const renderedRowHeight = renderedRow?.getBoundingClientRect().height || 0;
    const charWidth = rect.width / 100;
    const charHeight = Math.max(
      rect.height,
      renderedRowHeight,
      term.options.fontSize * term.options.lineHeight,
    );

    probe.remove();

    return {
      width: charWidth || 8,
      height: charHeight || term.options.fontSize * term.options.lineHeight,
    };
  }

  function focusTerminalInput() {
    if (!isRunning) return;

    term.focus();
    term.options.cursorBlink = true;

    const helperInput =
      term.textarea || document.querySelector(".xterm-helper-textarea");

    if (helperInput) {
      helperInput.autocomplete = "off";
      helperInput.autocorrect = "off";
      helperInput.autocapitalize = "off";
      helperInput.spellcheck = false;
      helperInput.focus({ preventScroll: true });
    }
  }

  function queueTerminalFocus() {
    requestAnimationFrame(() => {
      focusTerminalInput();
      setTimeout(focusTerminalInput, 30);
      setTimeout(focusTerminalInput, 120);
    });
  }

  function scrollTerminalToBottom() {
    requestAnimationFrame(() => {
      try {
        term.scrollToBottom();

        const viewport = outputElement.querySelector(".xterm-viewport");
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight;
          setTimeout(() => {
            viewport.scrollTop = viewport.scrollHeight;
          }, 0);
        }
      } catch (e) {}
    });
  }

  function writeTerminal(message, callback) {
    term.write(message, () => {
      scrollTerminalToBottom();
      if (callback) callback();
    });
  }

  outputElement.addEventListener("pointerdown", () => {
    focusTerminalInput();
  });

  outputElement.addEventListener("click", () => {
    if (isRunning) {
      focusTerminalInput();
    }
  });

  let fitFrame = null;
  function fitTerminalNow() {
    try {
      const hasSize =
        outputElement.clientWidth > 0 && outputElement.clientHeight > 0;

      if (hasSize) {
        const cell = measureTerminalCell();
        const viewport = outputElement.querySelector(".xterm-viewport");
        const outputStyle = window.getComputedStyle(outputElement);
        const horizontalPadding =
          parseFloat(outputStyle.paddingLeft) +
          parseFloat(outputStyle.paddingRight);
        const verticalPadding =
          parseFloat(outputStyle.paddingTop) +
          parseFloat(outputStyle.paddingBottom);
        const scrollbarWidth = viewport
          ? Math.max(0, viewport.offsetWidth - viewport.clientWidth)
          : 0;
        const cols = Math.max(
          2,
          Math.floor(
            (outputElement.clientWidth - horizontalPadding - scrollbarWidth) /
              cell.width,
          ),
        );
        const rows = Math.max(
          1,
          Math.floor(
            (outputElement.clientHeight - verticalPadding) / cell.height,
          ),
        );

        if (term.cols !== cols || term.rows !== rows) {
          term.resize(cols, rows);
        }
      }
    } catch (e) {}
  }

  function safeFit() {
    if (fitFrame) {
      cancelAnimationFrame(fitFrame);
    }

    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;

      fitTerminalNow();
    });
  }

  if (window.ResizeObserver) {
    const terminalResizeObserver = new ResizeObserver(() => safeFit());
    terminalResizeObserver.observe(outputElement);
    terminalResizeObserver.observe(outputContainer);
  }

  function sendBufferedInput(inputValue = inputBuffer) {
    if (socket.readyState !== WebSocket.OPEN) {
      showToast("Compiler is reconnecting. Try again in a moment.", true);
      connectWebSocket();
      return;
    }

    socket.send(JSON.stringify({ type: "input", input: `${inputValue}\n` }));
  }

  term.onData((data) => {
    if (!isRunning) return;

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        const submittedInput = inputBuffer;

        if (!submittedInput) {
          writeTerminal("\r\n", queueTerminalFocus);
          continue;
        }

        inputBuffer = "";
        writeTerminal("\r\n", () => sendBufferedInput(submittedInput));
        continue;
      }

      if (char === "\u007F" || char === "\b") {
        if (inputBuffer.length > 0) {
          inputBuffer = inputBuffer.slice(0, -1);
          writeTerminal("\b \b");
        }
        continue;
      }

      if (char >= " " || char === "\t") {
        inputBuffer += char;
        writeTerminal(char);
      }
    }
  });

  const LANG_CONFIG = {
    cpp: {
      mode: "text/x-c++src",
      label: "C++",
      filename: "main.cpp",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="bold" font-family="Arial">C++</text></svg>',
    },
    c: {
      mode: "text/x-csrc",
      label: "C",
      filename: "main.c",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="16" font-weight="bold" font-family="Arial">C</text></svg>',
    },
    java: {
      mode: "text/x-java",
      label: "Java",
      filename: "Main.java",
      svg: '<svg viewBox="0 0 128 128" fill="currentColor" width="20" height="20"><path d="M47.6 98.6c-3 1.6-7.5 3-7.5 3s2.6 1.5 7 2.1c5.8.8 12.2 1 18.6-.1 0 0 2.1 1.3 4.9 2.5-17.3 7.3-39.2-.4-23-7.5zm-3.7-8.5s-8.3 6.2 5.9 6.5c12.7.3 19.7-.3 33.5-4.5 0 0 3.7 3.7-6.3 7-22 7.3-46.3 1-33.9-3.8-1.2-.2 .8-5.2.8-5.2z"/><path d="M69.1 61.5c7.1 8.2-1.9 15.6-1.9 15.6s18.1-9.3 9.8-21c-7.7-10.9-13.7-16.3 18.5-35 0 0-50.5 12.6-26.4 40.4z"/><path d="M102.4 108.9s3 2.5-3.3 4.4c-12.1 3.7-50.2 4.8-60.8.1-3.8-1.7 3.3-4 5.5-4.5 2.3-.5 3.6-.4 3.6-.4-4.1-2.9-26.7 5.7-11.5 8.2 41.6 6.8 75.9-3.1 66.5-7.8zM49.7 72.3c-17.5 7.2-6.6 14.1-2.6 13.2 1-.2 1.6-.4 1.6-.4s-.4.7-1.2 1c-8.9 3.3-26 1.9-21.1-1.8 5.9-4.4 23.3-12 23.3-12zm14.5 20.3c18 2.3 45.7-1.3 46.4-18 0 0-1.3 6.5-14.6 11.7-15 5.8-33.5 5.1-44.4 1.4 0 0 2.2 1.9 12.6 4.9z"/><path d="M76.5 1.4s15.6 15.6-14.8 39.5c-24.4 19.2-5.6 30.1 0 42.6-14.2-12.8-24.6-24.1-17.6-34.6C54.4 33.7 82.3 26.3 76.5 1.4z"/></svg>',
    },
    python: {
      mode: "text/x-python",
      label: "Python",
      filename: "main.py",
      svg: '<svg viewBox="0 0 128 128" fill="currentColor" width="20" height="20"><path d="M49.3 62H78.7c8.8 0 15.8-7.3 15.8-16.2V18.6c0-8.6-7.3-15.1-16-16.4-5.5-.8-11.2-1.2-16.7-1.1-5.5 0-10.7.4-15.4 1.1C35.2 3.8 30 9.5 30 18.6v11.8h34v3.9H30 18.7c-9.3 0-17.4 5.6-20 16.2-2.9 12.2-3.1 19.8 0 32.5 2.3 9.5 7.7 16.2 17 16.2H26V85.3c0-10.6 9.2-20 20-20h33.3c8.9 0 16-7.3 16-16.2v-27c0-8.7-7.3-15.2-16-16.8-5.5-.9-11.2-1.3-16.8-1.2-5.5 0-10.7.4-15.3 1.2-8.7 1.6-12.9 6.3-12.9 16.8V46H68v3.9H49.3v12zm-2.8-39.8c-3.3 0-6-2.7-6-6.1 0-3.4 2.7-6.1 6-6.1 3.3 0 6 2.7 6 6.1 0 3.4-2.7 6.1-6 6.1z"/><path d="M112.4 50.2c-2.3-9.3-6.7-16.2-16-16.2H87v12.8c0 11.1-9.4 20.4-20.3 20.4H33.4c-8.8 0-16 7.5-16 16.3V110.5c0 8.6 7.5 13.7 16 16.2 10.2 3 19.9 3.6 32 0 8-2.4 16-7.2 16-16.2V98.7H48v-3.9h33.3 16c9.3 0 12.8-6.5 16-16.2 3.3-10 3.2-19.7 0-32.5zM81.5 105.9c3.3 0 6 2.7 6 6.1 0 3.4-2.7 6.1-6 6.1-3.3 0-6-2.7-6-6.1 0-3.3 2.7-6.1 6-6.1z"/></svg>',
    },
    javascript: {
      mode: "text/javascript",
      label: "JavaScript",
      filename: "main.js",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect width="24" height="24" rx="2" fill="currentColor" opacity="0.15"/><text x="12" y="17" text-anchor="middle" font-size="12" font-weight="bold" font-family="Arial">JS</text></svg>',
    },
    typescript: {
      mode: "text/typescript",
      label: "TypeScript",
      filename: "main.ts",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect width="24" height="24" rx="2" fill="currentColor" opacity="0.15"/><text x="12" y="17" text-anchor="middle" font-size="12" font-weight="bold" font-family="Arial">TS</text></svg>',
    },
    go: {
      mode: "text/x-go",
      label: "Go",
      filename: "main.go",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="bold" font-family="Arial">Go</text></svg>',
    },
    kotlin: {
      mode: "text/x-kotlin",
      label: "Kotlin",
      filename: "main.kt",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="0,24 12,12 24,24" fill="currentColor" opacity="0.5"/><polygon points="0,0 24,0 12,12 0,24" fill="currentColor"/></svg>',
    },
    ruby: {
      mode: "text/x-ruby",
      label: "Ruby",
      filename: "main.rb",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="12,2 22,9 18,22 6,22 2,9" fill="currentColor"/></svg>',
    },
    php: {
      mode: "application/x-httpd-php",
      label: "PHP",
      filename: "main.php",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><ellipse cx="12" cy="12" rx="11" ry="7" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1"/><text x="12" y="15" text-anchor="middle" font-size="9" font-weight="bold" font-family="Arial">PHP</text></svg>',
    },
    bash: {
      mode: "text/x-sh",
      label: "Bash",
      filename: "main.sh",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect x="2" y="3" width="20" height="18" rx="2" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="bold" font-family="monospace">&gt;_</text></svg>',
    },
    rust: {
      mode: "text/x-rustsrc",
      label: "Rust",
      filename: "main.rs",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="bold" font-family="Arial">Rs</text></svg>',
    },
    csharp: {
      mode: "text/x-csharp",
      label: "C#",
      filename: "main.cs",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="bold" font-family="Arial">C#</text></svg>',
    },
    perl: {
      mode: "text/x-perl",
      label: "Perl",
      filename: "main.pl",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="11" font-weight="bold" font-family="Arial">Perl</text></svg>',
    },
    lua: {
      mode: "text/x-lua",
      label: "Lua",
      filename: "main.lua",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="11" font-weight="bold" font-family="Arial">Lua</text></svg>',
    },
    r: {
      mode: "text/x-rsrc",
      label: "R",
      filename: "main.r",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><text x="12" y="17" text-anchor="middle" font-size="16" font-weight="bold" font-family="Arial">R</text></svg>',
    },
    html: {
      mode: "text/html",
      label: "HTML",
      filename: "index.html",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><rect width="24" height="24" rx="2" fill="currentColor" opacity="0.15"/><text x="12" y="16" text-anchor="middle" font-size="8" font-weight="bold" font-family="Arial">HTML</text></svg>',
    },
    sql: {
      mode: "text/x-sql",
      label: "SQL",
      filename: "main.sql",
      svg: '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><ellipse cx="12" cy="6" rx="8" ry="3" fill="currentColor"/><path d="M4 6v5c0 1.66 3.58 3 8 3s8-1.34 8-3V6" fill="currentColor" opacity="0.5"/><path d="M4 11v5c0 1.66 3.58 3 8 3s8-1.34 8-3v-5" fill="currentColor" opacity="0.3"/></svg>',
    },
  };

  const pathParts = window.location.pathname.split("/");
  const routeLang = pathParts[1]
    ? pathParts[1].replace(/-online-compiler$/, "").replace(/-programming$/, "")
    : "";
  let currentLanguage = LANG_CONFIG[routeLang] ? routeLang : "cpp";

  // Detect if this is a shared code URL
  const isShareRoute =
    window.location.pathname.startsWith("/c/") ||
    window.location.pathname.startsWith("/share/");

  if (!isShareRoute) {
    history.replaceState(
      null,
      "",
      currentLanguage === "html" ? "/html" : `/${currentLanguage}-online-compiler`,
    );
  } else {
    // Clean trailing slash for share URLs
    if (window.location.href.endsWith("/")) {
      history.pushState(null, "", window.location.href.replace(/\/$/, ""));
    }
  }

  const statusLang = document.getElementById("status-language");
  const sidebarList = document.querySelector(".sidebar-list");

  function renderSidebar() {
    if (!sidebarList) return;
    sidebarList.innerHTML = "";
    Object.keys(LANG_CONFIG).forEach((key) => {
      const cfg = LANG_CONFIG[key];
      const li = document.createElement("li");
      li.className = `sidebar-item ${key === currentLanguage ? "active" : ""}`;
      li.dataset.lang = key;
      li.innerHTML = cfg.svg;
      li.title = cfg.label;

      li.addEventListener("click", () => {
        if (currentLanguage === key) return;
        window.location.href = key === "html" ? "/html" : `/${key}-online-compiler`;
      });
      sidebarList.appendChild(li);
    });
  }

  renderSidebar();

  const activeItem = sidebarList?.querySelector(".sidebar-item.active");
  if (activeItem) activeItem.scrollIntoView({ block: "end" });

  async function fetchSharedCode() {
    const pathName = window.location.pathname;
    try {
      const res = await fetch(`/code${pathName}`, { method: "POST" });
      if (!res.ok) {
        window.location.replace("/404.html");
        return false;
      }

      const data = await res.json();
      if (!data) return false;

      if (data.language && LANG_CONFIG[data.language]) {
        currentLanguage = data.language;
        renderSidebar();
      }
      window._sharedCode = data.code || "";
      window._sharedFilename = data.filename || "";

      const fileName = data.filename.toString().split("/").pop();
      if (fileNameEditor) fileNameEditor.textContent = fileName;
      document.querySelector("title").textContent = fileName;

      return true;
    } catch (e) {
      return false;
    }
  }

  function showHtmlPreview(htmlCode) {
    const preview = document.getElementById("html-preview");
    if (!preview) return;
    // Inline the polyfill so it runs synchronously before any user scripts.
    // Using <script src> in a blob iframe can have cross-origin timing issues.
    // _polySrc is fetched at startup from /poly-storage.js (never obfuscated).
    const polyTag = _polySrc
      ? `<script>${_polySrc}<\/script>`
      : `<script src="${window.location.origin}/poly-storage.js"><\/script>`;
    const injected = /<head(\s[^>]*)?>/i.test(htmlCode)
      ? htmlCode.replace(/(<head(\s[^>]*)?>)/i, "$1" + polyTag)
      : polyTag + htmlCode;
    const blob = new Blob([injected], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    if (preview._lastUrl) URL.revokeObjectURL(preview._lastUrl);
    preview._lastUrl = url;
    preview.src = url;
    outputElement.style.display = "none";
    preview.style.display = "block";
    if (window.innerWidth <= 768) showOutput();
    else safeFit();
  }

  function hideHtmlPreview() {
    const preview = document.getElementById("html-preview");
    if (!preview || preview.style.display === "none") return;
    preview.style.display = "none";
    if (preview._lastUrl) {
      URL.revokeObjectURL(preview._lastUrl);
      preview._lastUrl = null;
      preview.src = "";
    }
    outputElement.style.display = "block";
    safeFit();
  }

  function parseMySQLOutput(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (/^\+[-+]+\+$/.test(trimmed)) {
        const table = { headers: [], rows: [] };
        i++;
        if (i < lines.length && lines[i].trim().startsWith("|")) {
          table.headers = lines[i]
            .trim()
            .slice(1, -1)
            .split("|")
            .map((c) => c.trim());
          i++;
        }
        if (i < lines.length && /^\+[-+]+\+$/.test(lines[i].trim())) i++;
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          table.rows.push(
            lines[i]
              .trim()
              .slice(1, -1)
              .split("|")
              .map((c) => c.trim()),
          );
          i++;
        }
        if (i < lines.length && /^\+[-+]+\+$/.test(lines[i].trim())) i++;
        blocks.push({
          type: "table",
          headers: table.headers,
          rows: table.rows,
        });
      } else if (trimmed) {
        blocks.push({ type: "message", text: trimmed });
        i++;
      } else {
        i++;
      }
    }
    return blocks;
  }

  function renderSqlResults(rawOutput) {
    const container = document.getElementById("sql-results");
    if (!container) return;
    container.innerHTML = "";
    const blocks = parseMySQLOutput(rawOutput);
    if (!blocks.length) {
      container.innerHTML =
        '<p class="sql-message">Query executed. No output.</p>';
    } else {
      for (const block of blocks) {
        if (block.type === "table") {
          const wrapper = document.createElement("div");
          wrapper.className = "sql-table-wrapper";
          const tbl = document.createElement("table");
          tbl.className = "sql-table";
          const thead = document.createElement("thead");
          const hrow = document.createElement("tr");
          block.headers.forEach((h) => {
            const th = document.createElement("th");
            th.textContent = h;
            hrow.appendChild(th);
          });
          thead.appendChild(hrow);
          tbl.appendChild(thead);
          const tbody = document.createElement("tbody");
          block.rows.forEach((row) => {
            const tr = document.createElement("tr");
            row.forEach((cell) => {
              const td = document.createElement("td");
              if (cell === "NULL") {
                td.textContent = "NULL";
                td.className = "sql-null";
              } else {
                td.textContent = cell;
              }
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          tbl.appendChild(tbody);
          wrapper.appendChild(tbl);
          const meta = document.createElement("div");
          meta.className = "sql-table-meta";
          meta.textContent = `${block.rows.length} row${block.rows.length !== 1 ? "s" : ""}`;
          wrapper.appendChild(meta);
          container.appendChild(wrapper);
        } else {
          const p = document.createElement("p");
          p.className = block.text.startsWith("ERROR")
            ? "sql-error"
            : "sql-message";
          p.textContent = block.text;
          container.appendChild(p);
        }
      }
    }
    outputElement.style.display = "none";
    container.style.display = "block";
  }

  function hideSqlResults() {
    const container = document.getElementById("sql-results");
    if (!container || container.style.display === "none") return;
    container.style.display = "none";
    outputElement.style.display = "block";
    safeFit();
  }

  function applyLanguage(langKey) {
    const cfg = LANG_CONFIG[langKey];
    if (!cfg) return;
    if (langKey !== "html") hideHtmlPreview();
    if (langKey !== "sql") hideSqlResults();
    currentLanguage = langKey;
    if (editor) editor.setOption("mode", cfg.mode);
    if (statusLang) statusLang.textContent = cfg.label;
    if (term) term.reset();
    const subtitle = document.getElementById("ai-write-subtitle");
    if (subtitle)
      subtitle.textContent = `Describe the ${cfg.label} program you want to create`;
    const brandSub = document.getElementById("brand-lang-subtitle");
    if (brandSub) brandSub.textContent = cfg.label + " Online Compiler";
    document.title = cfg.label + " Online Compiler — CompileAny";
    if (langKey === "html") {
      const fixBtn = document.getElementById("ai-fix-btn");
      if (fixBtn) fixBtn.style.display = "none";
    }
  }

  window._lastDefaultCode = "";

  async function fetchAndApplyDefaultCode(langKey, force = false) {
    try {
      const res = await fetch(`/default-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: langKey }),
      });
      if (!res.ok) {
        showToast("Something went wrong.");
        return;
      }
      const data = await res.json();
      if (!data) return;

      if (data.language) {
        currentLanguage = data.language;
        applyLanguage(currentLanguage);
        document
          .querySelectorAll(".sidebar-item")
          .forEach((el) => el.classList.remove("active"));
        const activeEl = document.querySelector(
          `.sidebar-item[data-lang="${currentLanguage}"]`,
        );
        if (activeEl) activeEl.classList.add("active");
      }

      const fileName = data.filename.toString().split("/").pop();
      fileNameEditor.textContent = fileName;
      document.querySelector("title").textContent = fileName;

      if (!editor) return;

      if (
        force ||
        !editor.getValue().trim() ||
        editor.getValue() === window._lastDefaultCode
      ) {
        editor.setValue(data.code);
      }
      window._lastDefaultCode = data.code;
      editor.refresh();
    } catch (e) {}
  }

  // --- Encrypted session persistence (AES-GCM via Web Crypto) ---
  const hasSubtleCrypto = !!(window.crypto && window.crypto.subtle);
  let sessionCryptoKey = null;

  async function getSessionKey() {
    if (sessionCryptoKey) return sessionCryptoKey;

    const storedJwk = sessionStorage.getItem("sk");
    if (storedJwk) {
      try {
        sessionCryptoKey = await crypto.subtle.importKey(
          "jwk",
          JSON.parse(storedJwk),
          { name: "AES-GCM" },
          false,
          ["encrypt", "decrypt"],
        );
        return sessionCryptoKey;
      } catch (e) {}
    }

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const exported = await crypto.subtle.exportKey("jwk", key);
    sessionStorage.setItem("sk", JSON.stringify(exported));
    sessionCryptoKey = key;
    return key;
  }

  async function encryptText(text) {
    if (!hasSubtleCrypto) {
      // Insecure context fallback: encode only
      return (
        "b64:" + btoa(String.fromCharCode(...new TextEncoder().encode(text)))
      );
    }
    const key = await getSessionKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(text),
    );
    const buf = new Uint8Array(iv.length + cipher.byteLength);
    buf.set(iv);
    buf.set(new Uint8Array(cipher), iv.length);
    let binary = "";
    buf.forEach((b) => (binary += String.fromCharCode(b)));
    return "enc:" + btoa(binary);
  }

  async function decryptText(payload) {
    try {
      if (payload.startsWith("b64:")) {
        return new TextDecoder().decode(
          Uint8Array.from(atob(payload.slice(4)), (c) => c.charCodeAt(0)),
        );
      }
      if (!payload.startsWith("enc:") || !hasSubtleCrypto) return null;
      const key = await getSessionKey();
      const buf = Uint8Array.from(atob(payload.slice(4)), (c) =>
        c.charCodeAt(0),
      );
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf.slice(0, 12) },
        key,
        buf.slice(12),
      );
      return new TextDecoder().decode(plain);
    } catch (e) {
      return null;
    }
  }

  async function saveSession() {
    try {
      const payload = JSON.stringify({
        code: editor.getValue(),
        filename: fileNameEditor.textContent.trim(),
      });
      const encrypted = await encryptText(payload);
      sessionStorage.setItem(`code:${currentLanguage}`, encrypted);
    } catch (e) {}
  }

  async function restoreSession() {
    try {
      const stored = sessionStorage.getItem(`code:${currentLanguage}`);
      if (!stored) return false;
      const plain = await decryptText(stored);
      if (!plain) return false;
      const data = JSON.parse(plain);
      if (!data.code || !data.code.trim()) return false;
      editor.setValue(data.code);
      if (data.filename) {
        fileNameEditor.textContent = data.filename;
        document.querySelector("title").textContent = data.filename;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  let autoSaveEnabled = localStorage.getItem("autoSave") !== "false";
  let autosaveTimer = null;

  function scheduleAutosave() {
    if (!autoSaveEnabled) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveSession, 600);
  }

  CodeMirror.registerHelper("hint", "custom", function (cm, options) {
    const word = /^[a-zA-Z0-9_]+$/;
    const cur = cm.getCursor(),
      curLine = cm.getLine(cur.line);
    let start = cur.ch,
      end = start;
    while (start && word.test(curLine.charAt(start - 1))) --start;
    while (end < curLine.length && word.test(curLine.charAt(end))) ++end;

    const curWord = start !== end && curLine.slice(start, cur.ch);
    const list = [];
    const seen = new Set();

    function add(str) {
      if (!seen.has(str)) {
        seen.add(str);
        list.push(str);
      }
    }

    const anywordResult = CodeMirror.hint.anyword(cm, options);
    if (anywordResult && anywordResult.list) {
      anywordResult.list.forEach(add);
    }

    if (curWord) {
      const state = cm.getTokenAt(cur).state;
      const innerMode = CodeMirror.innerMode(cm.getMode(), state).mode;

      if (innerMode.keywords) {
        Object.keys(innerMode.keywords).forEach((kw) => {
          if (kw.startsWith(curWord)) add(kw);
        });
      }
      if (innerMode.builtins) {
        Object.keys(innerMode.builtins).forEach((kw) => {
          if (kw.startsWith(curWord)) add(kw);
        });
      }
      if (innerMode.atoms) {
        Object.keys(innerMode.atoms).forEach((kw) => {
          if (kw.startsWith(curWord)) add(kw);
        });
      }
      const hintWords = cm.getHelper(cur, "hintWords");
      if (hintWords) {
        hintWords.forEach((kw) => {
          if (kw.startsWith(curWord)) add(kw);
        });
      }
    }

    return {
      list: list,
      from: CodeMirror.Pos(cur.line, start),
      to: CodeMirror.Pos(cur.line, cur.ch),
    };
  });

  editor = CodeMirror.fromTextArea(document.getElementById("code"), {
    mode: "text/x-c++src",
    theme: "dracula",
    lineNumbers: true,
    tabSize: 4,
    indentUnit: 4,
    smartIndent: true,
    autoCloseBrackets: true,
    matchBrackets: true,
    styleActiveLine: true,
    foldGutter: true,
    gutters: [
      "CodeMirror-linenumbers",
      "CodeMirror-foldgutter",
      "CodeMirror-lint-markers",
    ],
    lint: true,
    extraKeys: {
      "Ctrl-/": "toggleComment",
      "Ctrl-Space": function (cm) {
        cm.showHint({ hint: CodeMirror.hint.custom, completeSingle: false });
      },
    },
    hintOptions: { hint: CodeMirror.hint.custom, completeSingle: false },
  });

  if (isShareRoute) {
    const loaded = await fetchSharedCode();
    if (!loaded) return;
    applyLanguage(currentLanguage);
    if (window._sharedCode) {
      editor.setValue(window._sharedCode);
      window._lastDefaultCode = window._sharedCode;
      delete window._sharedCode;
      delete window._sharedFilename;
    }
  } else {
    const restored = await restoreSession();
    if (!restored) {
      fetchAndApplyDefaultCode(currentLanguage);
    }
    applyLanguage(currentLanguage);
  }

  editor.on("change", scheduleAutosave);

  editor.on("inputRead", function (cm, change) {
    if (!cm.state.completionActive && change.text[0].match(/^[a-zA-Z0-9_]+$/)) {
      cm.showHint({ hint: CodeMirror.hint.custom, completeSingle: false });
    }
  });

  const cursorPosEl = document.getElementById("cursor-position");
  editor.on("cursorActivity", function (cm) {
    const pos = cm.getCursor();
    if (cursorPosEl) {
      cursorPosEl.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
    }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runCode();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveSession().then(() => showToast("Code saved in editor!"));
    }

    if (e.altKey && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      editor.setValue("");
      editor.focus();
      showToast("Code cleared!");
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "o") {
      e.preventDefault();
      handleContextAction("import");
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyS") {
      e.preventDefault();
      handleContextAction("download");
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyN") {
      e.preventDefault();
      handleContextAction("new");
    }
  });

  // --- Run Code ---
  const aiFixBtn = document.getElementById("ai-fix-btn");

  function canSendCode() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      return true;
    }

    showToast("Compiler is reconnecting. Try again in a moment.", true);
    connectWebSocket();
    return false;
  }

  function runCode() {
    if (currentLanguage === "html") {
      showHtmlPreview(editor.getValue());
      return;
    }

    hideHtmlPreview();

    if (!canSendCode()) {
      setRunLoading(false);
      return;
    }

    if (window.innerWidth <= 768) {
      showOutput();
    } else if (editorView !== 0) {
      editorView = 0;
      responsive();
    }

    fitTerminalNow();

    term.reset();
    writeTerminal("\x1b[?25h");
    fitTerminalNow();
    inputBuffer = "";
    isRunning = false;
    currentRunId = null;
    lastCompileError = "";
    term.options.disableStdin = true;
    term.options.cursorBlink = false;
    document.getElementById("execution-time").textContent = "0.00s";
    if (aiFixBtn) aiFixBtn.style.display = "none";

    socket.send(
      JSON.stringify({
        type: "code",
        language: currentLanguage,
        code: editor.getValue(),
      }),
    );
    setRunLoading(true);
  }

  const runCodeElem = document.querySelectorAll(".run-code");
  function setRunLoading(isLoading) {
    runCodeElem.forEach((btn) => {
      if (isLoading) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play"></i> <span>Run</span>';
      }
    });
  }

  runCodeElem.forEach((e) => {
    e.addEventListener("click", runCode);
  });

  function handleSocketMessage(event) {
    let data = JSON.parse(event.data);

    if (data.runId && currentRunId && data.runId !== currentRunId) {
      return;
    }

    const isSql = currentLanguage === "sql";

    if (data.type === "compiled") {
    } else if (data.type === "running") {
      currentRunId = data.runId || null;
      fitTerminalNow();
      isRunning = true;
      if (isSql) {
        sqlOutputBuffer = "";
        const container = document.getElementById("sql-results");
        if (container) {
          container.innerHTML =
            '<p class="sql-message sql-loading">Running query…</p>';
          outputElement.style.display = "none";
          container.style.display = "block";
        }
      } else {
        term.options.disableStdin = false;
        term.options.cursorBlink = true;
        writeTerminal("\x1b[?25h");
        queueTerminalFocus();
      }
      setRunLoading(false);
    } else if (data.type === "output") {
      fitTerminalNow();
      isRunning = true;
      if (isSql) {
        sqlOutputBuffer += data.message;
      } else {
        term.options.disableStdin = false;
        term.options.cursorBlink = true;
        writeTerminal(data.message);
        queueTerminalFocus();
      }
    } else if (data.type === "stderr") {
      fitTerminalNow();
      isRunning = true;
      lastCompileError += data.message || "";
      if (isSql) {
        sqlOutputBuffer += data.message;
      } else {
        term.options.disableStdin = false;
        term.options.cursorBlink = true;
        writeTerminal("\x1b[31m" + data.message + "\x1b[0m");
      }
    } else if (data.type === "error") {
      fitTerminalNow();
      isRunning = false;
      currentRunId = null;
      inputBuffer = "";
      lastCompileError = data.message;
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
      if (isSql) {
        sqlOutputBuffer += data.message || "";
        renderSqlResults(sqlOutputBuffer);
        if (aiFixBtn) aiFixBtn.style.display = "flex";
      } else {
        writeTerminal("\x1b[31m" + data.message + "\x1b[0m");
        writeTerminal("\x1b[?25l");
        if (aiFixBtn) aiFixBtn.style.display = "flex";
        const outputMsg =
          data.exitCode === 0
            ? ""
            : `\r\n\x1b[90m=== Code Exited With Errors ===\x1b[0m`;
        writeTerminal("\r\n" + outputMsg + "\r\n");
      }
      setRunLoading(false);
    } else if (data.type === "finished") {
      if (!isRunning) return;
      isRunning = false;
      currentRunId = null;
      inputBuffer = "";
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
      if (isSql) {
        renderSqlResults(sqlOutputBuffer);
        document.getElementById("execution-time").textContent =
          data.timer + "s";
        if (data.exitCode !== 0 && lastCompileError && aiFixBtn) {
          aiFixBtn.style.display = "flex";
        }
      } else {
        const outputMsg =
          data.exitCode === 0
            ? `\r\n\x1b[34mExecution time: ${data.timer}s\x1b[0m\r\n\x1b[90m=== Code Execution Successful ===\x1b[0m`
            : `\r\n\x1b[34mExecution time: ${data.timer}s\x1b[0m\r\n\x1b[90m=== Code Exited With Errors ===\x1b[0m`;
        writeTerminal("\r\n" + outputMsg + "\r\n");
        document.getElementById("execution-time").textContent =
          data.timer + "s";
        if (data.exitCode !== 0 && lastCompileError && aiFixBtn) {
          aiFixBtn.style.display = "flex";
        }
      }
      setRunLoading(false);
    }
  }

  function handleSocketError() {
    isRunning = false;
    currentRunId = null;
    inputBuffer = "";
    writeTerminal("\x1b[?25l");
    term.options.disableStdin = true;
    term.options.cursorBlink = false;
    setRunLoading(false);
  }

  function handleSocketClose() {
    isRunning = false;
    currentRunId = null;
    inputBuffer = "";
    writeTerminal("\x1b[?25l");
    term.options.disableStdin = true;
    term.options.cursorBlink = false;
    setRunLoading(false);

    const statusElement = document.querySelector(
      ".status-item:nth-child(2) span",
    );
    if (statusElement) {
      statusElement.textContent = "Reconnecting...";
      statusElement.style.color = "var(--warning-text)";
    }

    const delay = Math.min(
      1000 * Math.pow(2, reconnectAttempts),
      maxReconnectDelay,
    );

    reconnectAttempts++;
    setTimeout(() => {
      connectWebSocket();
    }, delay);
  }

  // --- Clipboard helpers (browser-native first, Clipboard API fallback) ---
  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error("Clipboard unavailable"));
  }

  async function readClipboardText() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      return navigator.clipboard.readText();
    }
    throw new Error("Clipboard unavailable");
  }

  // --- Copy Code ---
  function copyCode() {
    copyTextToClipboard(editor.getValue())
      .then(() => {
        showToast("Code copied to clipboard!");
      })
      .catch(() => {
        showToast("Failed to copy code", true);
      });
  }

  const copyCodeElem = document.querySelectorAll(".copy-code");
  copyCodeElem.forEach((e) => {
    e.addEventListener("click", copyCode);
  });

  // Toast feedback for native Ctrl+C / Ctrl+X / Ctrl+V inside the editor
  const editorWrapper = editor.getWrapperElement();
  editorWrapper.addEventListener("copy", () => {
    showToast("Copied to clipboard!");
  });
  editorWrapper.addEventListener("cut", () => {
    showToast("Cut to clipboard!");
  });
  editorWrapper.addEventListener("paste", () => {
    showToast("Pasted from clipboard!");
  });

  // --- Editor / Output Context Menu ---
  const contextMenu = document.getElementById("editor-context-menu");
  const importFileInput = document.getElementById("import-file-input");
  let contextMenuTarget = "editor";

  function hideContextMenu() {
    if (contextMenu) contextMenu.classList.remove("visible");
  }

  function updateAutoSaveMenu() {
    document.querySelectorAll('[data-action="autosave"]').forEach((item) => {
      const icon = item.querySelector("i");
      const state = item.querySelector(".context-menu-shortcut");
      if (icon)
        icon.className = autoSaveEnabled
          ? "fas fa-toggle-on"
          : "fas fa-toggle-off";
      if (state) state.textContent = autoSaveEnabled ? "On" : "Off";
    });
  }

  updateAutoSaveMenu();

  function getTerminalText() {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join("\n").replace(/\n+$/, "");
  }

  function showContextMenu(x, y) {
    if (!contextMenu) return;

    contextMenu.style.left = "0px";
    contextMenu.style.top = "0px";
    contextMenu.classList.add("visible");

    const menuRect = contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - menuRect.width - 8;
    const maxY = window.innerHeight - menuRect.height - 8;

    contextMenu.style.left = `${Math.max(8, Math.min(x, maxX))}px`;
    contextMenu.style.top = `${Math.max(8, Math.min(y, maxY))}px`;
  }

  function downloadCode() {
    const filename =
      fileNameEditor.textContent.trim() ||
      LANG_CONFIG[currentLanguage]?.filename ||
      "main.txt";
    const blob = new Blob([editor.getValue()], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(`Downloaded ${filename}!`);
  }

  async function handleContextAction(action) {
    hideContextMenu();

    switch (action) {
      case "run":
        runCode();
        break;
      case "new": {
        const ext = (LANG_CONFIG[currentLanguage]?.filename || "main.txt")
          .split(".")
          .pop();
        const newName = `untitled.${ext}`;
        editor.setValue("");
        window._lastDefaultCode = "";
        fileNameEditor.textContent = newName;
        document.querySelector("title").textContent = newName;
        editor.focus();
        showToast("New file created!");
        break;
      }
      case "save":
        await saveSession();
        showToast("Code saved in editor!");
        break;
      case "autosave":
        autoSaveEnabled = !autoSaveEnabled;
        localStorage.setItem("autoSave", String(autoSaveEnabled));
        updateAutoSaveMenu();
        if (autoSaveEnabled) {
          saveSession();
          showToast("Auto save enabled!");
        } else {
          showToast("Auto save disabled");
        }
        break;
      case "import":
        if (importFileInput) importFileInput.click();
        break;
      case "download":
        downloadCode();
        break;
      case "copy": {
        let text;
        let toastMsg;
        if (contextMenuTarget === "output") {
          const sel = term.getSelection();
          text = sel || getTerminalText();
          toastMsg = sel
            ? "Selection copied to clipboard!"
            : "Output copied to clipboard!";
          if (!text.trim()) {
            showToast("Output is empty", true);
            break;
          }
        } else {
          const hasSelection = editor.somethingSelected();
          text = hasSelection ? editor.getSelection() : editor.getValue();
          toastMsg = hasSelection
            ? "Selection copied to clipboard!"
            : "Code copied to clipboard!";
        }
        try {
          await copyTextToClipboard(text);
          showToast(toastMsg);
        } catch (err) {
          showToast("Failed to copy", true);
        }
        if (contextMenuTarget === "editor") editor.focus();
        break;
      }
      case "paste":
        if (contextMenuTarget === "output") {
          if (!isRunning) {
            showToast("Run the code first to send input", true);
            break;
          }
          try {
            const text = await readClipboardText();
            // Strip line breaks so paste never auto-submits input
            const sanitized = (text || "")
              .replace(/(\r\n|\r|\n)+/g, " ")
              .trim();
            if (sanitized) {
              inputBuffer += sanitized;
              writeTerminal(sanitized);
              queueTerminalFocus();
              showToast("Pasted! Press Enter to send input.");
            } else {
              showToast("Clipboard is empty", true);
            }
          } catch (err) {
            showToast("Paste blocked by browser. Press Ctrl+V instead.", true);
          }
          break;
        }
        try {
          const text = await readClipboardText();
          if (text) {
            editor.replaceSelection(text);
            showToast("Pasted from clipboard!");
          } else {
            showToast("Clipboard is empty", true);
          }
        } catch (err) {
          showToast("Paste blocked by browser. Press Ctrl+V instead.", true);
        }
        editor.focus();
        break;
      case "clear":
        if (contextMenuTarget === "output") {
          term.reset();
          showToast("Output cleared!");
        } else {
          editor.setValue("");
          editor.focus();
          showToast("Code cleared!");
        }
        break;
    }
  }

  if (contextMenu) {
    function openContextMenu(e, target) {
      e.preventDefault();
      contextMenuTarget = target;
      showContextMenu(e.clientX, e.clientY);
    }

    editorContainer.addEventListener("contextmenu", (e) =>
      openContextMenu(e, "editor"),
    );
    outputContainer.addEventListener("contextmenu", (e) =>
      openContextMenu(e, "output"),
    );

    contextMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".context-menu-item");
      if (item) handleContextAction(item.dataset.action);
    });

    const mobileActions = document.querySelector(".mobile-context-actions");
    if (mobileActions) {
      mobileActions.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        contextMenuTarget = "editor";
        hideLinks();
        handleContextAction(btn.dataset.action);
      });
    }

    document.addEventListener("click", (e) => {
      if (!contextMenu.contains(e.target)) hideContextMenu();
    });

    document.addEventListener("contextmenu", (e) => {
      if (
        !editorContainer.contains(e.target) &&
        !outputContainer.contains(e.target)
      ) {
        hideContextMenu();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideContextMenu();
    });

    window.addEventListener("resize", hideContextMenu);
    editor.on("scroll", hideContextMenu);
  }

  if (importFileInput) {
    importFileInput.addEventListener("change", () => {
      const file = importFileInput.files[0];
      if (!file) return;

      if (file.size > 500_000) {
        showToast("File too large (max 500 KB)", true);
        importFileInput.value = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        editor.setValue(reader.result);
        window._lastDefaultCode = "";
        fileNameEditor.textContent = file.name;
        document.querySelector("title").textContent = file.name;
        editor.refresh();
        editor.focus();
        showToast(`Imported ${file.name}!`);
      };
      reader.onerror = () => showToast("Failed to read file", true);
      reader.readAsText(file);
      importFileInput.value = "";
    });
  }

  // --- Editable file name (click on desktop, double-tap on mobile) ---
  if (fileNameEditor) {
    const isMobileView = () => window.innerWidth <= 768;

    function setFileNameEditable() {
      fileNameEditor.setAttribute(
        "contenteditable",
        isMobileView() ? "false" : "true",
      );
    }
    setFileNameEditable();
    window.addEventListener("resize", setFileNameEditable);

    function startMobileRename() {
      fileNameEditor.setAttribute("contenteditable", "true");
      fileNameEditor.focus();
      // Place a visible cursor at the end of the name instead of selecting all
      const range = document.createRange();
      range.selectNodeContents(fileNameEditor);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    fileNameEditor.addEventListener("click", (e) => {
      // While editable, keep clicks from triggering the parent view switch
      if (fileNameEditor.isContentEditable) e.stopPropagation();
    });

    fileNameEditor.addEventListener("dblclick", (e) => {
      if (!isMobileView() || fileNameEditor.isContentEditable) return;
      e.stopPropagation();
      startMobileRename();
    });

    let lastTap = 0;
    fileNameEditor.addEventListener("touchend", (e) => {
      if (!isMobileView() || fileNameEditor.isContentEditable) return;
      const now = Date.now();
      if (now - lastTap < 350) {
        e.preventDefault();
        e.stopPropagation();
        startMobileRename();
      }
      lastTap = now;
    });

    fileNameEditor.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        fileNameEditor.blur();
      }
      if (e.key === "Escape") {
        fileNameEditor.textContent =
          document.querySelector("title").textContent;
        fileNameEditor.blur();
      }
    });

    fileNameEditor.addEventListener("blur", () => {
      if (isMobileView()) {
        fileNameEditor.setAttribute("contenteditable", "false");
      }

      const oldName = document.querySelector("title").textContent;
      let name = fileNameEditor.textContent
        .trim()
        .replace(/[\\/:*?"<>|\r\n]/g, "");

      if (!name) {
        fileNameEditor.textContent = oldName;
        return;
      }

      const ext = (LANG_CONFIG[currentLanguage]?.filename || "main.txt")
        .split(".")
        .pop();
      if (!name.includes(".")) name += `.${ext}`;

      fileNameEditor.textContent = name;
      document.querySelector("title").textContent = name;
      if (name !== oldName) showToast(`File renamed to ${name}`);
    });
  }

  // --- Share URL ---
  async function generateCode() {
    const code = editor.getValue();
    const filename = LANG_CONFIG[currentLanguage]?.filename || "main.cpp";

    try {
      showLoading(true, "Generating...");
      const res = await fetch("/generate-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, filename, language: currentLanguage }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error("Failed to generate URL");
      showLoading(false);
      return data.url;
    } catch (err) {
      showLoading(false);
      return null;
    }
  }

  async function generateQrCode() {
    try {
      const shareUrl = await generateCode();

      if (!shareUrl) {
        throw new Error("Could not generate URL");
      }

      const res = await fetch("/generate-qrcode", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: shareUrl,
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.message || !data.qrcodeUrl) {
        throw new Error(data.error || "Failed to generate QR code");
      }

      return data.qrcodeUrl;
    } catch (err) {
      console.error("QR Generate Error:", err);
      showToast("Failed to generate QR code", true);
      return null;
    }
  }

  async function copyShareCode() {
    try {
      const shareUrl = await generateCode();

      if (!shareUrl) {
        throw new Error("Could not generate URL");
      }

      await navigator.clipboard.writeText(shareUrl);
      showToast("Share URL copied to clipboard!");
    } catch (err) {
      console.error("Copy Share URL Error:", err);
      showToast("Failed to copy share URL", true);
    }
  }

  const openModalShare = document.querySelectorAll(".open-model");
  openModalShare.forEach((e) => {
    e.addEventListener("click", openShareModel);
  });

  window.addEventListener("resize", () => {
    editor.refresh();
    safeFit();
  });

  // --- Drag Resize ---
  const dragbarVertical = document.getElementById("dragbar");
  const mainContainer = document.querySelector(".main-container");
  let isResizing = false;
  let resizeType = "";
  let initialX, initialY, initialEditorWidth, initialEditorHeight;

  function handleResize(e) {
    if (!isResizing) return;

    requestAnimationFrame(() => {
      const containerWidth = mainContainer.clientWidth;
      const containerHeight = mainContainer.clientHeight;

      if (resizeType === "horizontal") {
        const deltaX = e.clientX - initialX;
        let newEditorWidth =
          initialEditorWidth + (deltaX / containerWidth) * 100;

        if (newEditorWidth > 20 && newEditorWidth < 80) {
          editorContainer.style.width = `${newEditorWidth}%`;
          outputContainer.style.width = `${100 - newEditorWidth}%`;
        }
      } else if (resizeType === "vertical") {
        const deltaY = e.clientY - initialY;
        let newEditorHeight =
          initialEditorHeight + (deltaY / containerHeight) * 100;

        if (newEditorHeight > 20 && newEditorHeight < 80) {
          editorContainer.style.height = `${newEditorHeight}%`;
          outputContainer.style.height = `${100 - newEditorHeight}%`;
        }
      }
    });
  }

  dragbarVertical.addEventListener("mousedown", (e) => {
    isResizing = true;
    resizeType = "horizontal";
    initialX = e.clientX;
    initialEditorWidth = parseFloat(editorContainer.style.width) || 52;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  });

  // If there is a horizontal dragbar on mobile
  const dragbarHorizontal = document.getElementById("dragbar-horizontal");
  if (dragbarHorizontal) {
    dragbarHorizontal.addEventListener("mousedown", (e) => {
      isResizing = true;
      resizeType = "vertical";
      initialY = e.clientY;
      initialEditorHeight = parseFloat(editorContainer.style.height) || 50;
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    });
  }

  document.addEventListener("mousemove", handleResize);
  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      resizeType = "";
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
      editor.refresh();
      safeFit();
    }
  });

  // --- Themes ---
  const lightThemes = [
    "default",
    "base16-light",
    "eclipse",
    "mdn-like",
    "neat",
    "paraiso-light",
  ];

  const darkThemes = [
    "dracula",
    "monokai",
    "material",
    "ayu-dark",
    "gruvbox-dark",
    "panda-syntax",
  ];

  const themeSelector = document.getElementById("theme-selector");
  const themeToggle = document.querySelector(".mode");
  const savedMode = sessionStorage.getItem("themeMode");
  const prefersDarkScheme = window.matchMedia("(prefers-color-scheme: dark)");

  let themeFlag = savedMode ? savedMode === "dark" : prefersDarkScheme.matches;

  prefersDarkScheme.addEventListener("change", (e) => {
    if (!sessionStorage.getItem("themeMode")) {
      themeFlag = e.matches;
      applyThemeSettings();
    }
  });

  function updateThemeOptions(themes) {
    themeSelector.innerHTML = "";
    themes.forEach((theme) => {
      const option = document.createElement("option");
      option.value = theme;
      option.textContent = theme;
      themeSelector.appendChild(option);
    });
  }

  function loadTheme(theme) {
    if (theme === "default") {
      editor.setOption("theme", "default");
    } else {
      let link = document.getElementById("theme-stylesheet");
      if (!link) {
        link = document.createElement("link");
        link.rel = "stylesheet";
        link.id = "theme-stylesheet";
        document.head.appendChild(link);
      }
      link.href = `codemirror/theme/${theme.replace(/\s+/g, "-")}.css`;
      editor.setOption("theme", theme);
    }
    sessionStorage.setItem("selectedTheme", theme);
  }

  function toggleTheme() {
    themeFlag = !themeFlag;
    sessionStorage.setItem("themeMode", themeFlag ? "dark" : "light");
    sessionStorage.setItem("selectedTheme", themeFlag ? "dracula" : "default");
    applyThemeSettings();
    showToast(`Switched to ${themeFlag ? "dark" : "light"} mode!`);
  }

  function applyThemeSettings() {
    document.documentElement.classList.toggle("day", !themeFlag);
    if (term) {
      term.options.theme = themeFlag ? darkTerminalTheme : lightTerminalTheme;
    }
    themeToggle.innerHTML = themeFlag
      ? '<i class="fas fa-sun"></i><span class="hidden-mobile">Day</span>'
      : '<i class="fas fa-moon"></i><span class="hidden-mobile">Night</span>';
    updateThemeOptions(themeFlag ? darkThemes : lightThemes);
    const currentSavedTheme = sessionStorage.getItem("selectedTheme");
    const defaultTheme =
      currentSavedTheme || (themeFlag ? "dracula" : "default");
    themeSelector.value = defaultTheme;
    loadTheme(defaultTheme);
  }

  themeToggle.addEventListener("click", toggleTheme);
  themeSelector.addEventListener("change", function () {
    loadTheme(this.value);
  });

  applyThemeSettings();

  // --- Toast ---
  function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = "toast";
    const icon = document.createElement("i");
    if (isError) {
      toast.style.borderLeft = "4px solid var(--error-text)";
      icon.className = "fas fa-times-circle";
      icon.style.color = "var(--error-text)";
    } else {
      icon.className = "fas fa-check-circle";
    }
    toast.appendChild(icon);
    toast.appendChild(document.createTextNode(" " + message));
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  // --- Share Model ---
  const modelDiv = document.createElement("div");
  const divCloseX = document.createElement("div");
  const divCopy = document.createElement("div");
  const divModelImg = document.createElement("div");
  const modelImg = document.createElement("img");
  const menu = document.getElementById("menu-toggle");
  const links = document.querySelector(".btn-con");
  const blurCon = document.querySelector(".blur");
  let flag = false;

  if (modelDiv) {
    let offsetX = 0,
      offsetY = 0,
      isDragging = false;

    modelDiv.addEventListener("mousedown", (e) => {
      isDragging = true;
      offsetX = e.clientX - modelDiv.offsetLeft + 100;
      offsetY = e.clientY - modelDiv.offsetTop;
      document.addEventListener("mousemove", movewindow);
      document.addEventListener("mouseup", stopMove);
    });

    function movewindow(e) {
      if (!isDragging) return;

      const modelDivWidth = modelDiv.offsetWidth;
      const modelDivHeight = modelDiv.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let newLeft = e.clientX - offsetX;
      let newTop = e.clientY - offsetY;

      newLeft = Math.max(0, Math.min(viewportWidth - modelDivWidth, newLeft));
      newTop = Math.max(0, Math.min(viewportHeight - modelDivHeight, newTop));

      modelDiv.style.left = `${newLeft + 100}px`;
      modelDiv.style.top = `${newTop}px`;
    }

    function stopMove() {
      isDragging = false;
      document.removeEventListener("mousemove", movewindow);
      document.removeEventListener("mouseup", stopMove);
    }
  }

  async function openShareModel() {
    const qrCode = await generateQrCode();
    if (!qrCode) {
      showToast("Failed to generate QR code", true);
      return;
    }
    modelImg.src = qrCode;
    modelDiv.className = "model-div";
    divCloseX.className = "model-close";
    divCloseX.innerHTML = "&times;";
    divCopy.className = "model-copy";
    divCopy.innerHTML = `
          <button class="share-code btn btn-secondary">
            <i class="fa-solid fa-copy"></i>
            COPY URL
          </button>
    `;
    divModelImg.innerHTML = "";
    divModelImg.className = "model-img";
    divModelImg.appendChild(modelImg);
    modelDiv.innerHTML = "";
    modelDiv.appendChild(divCloseX);
    modelDiv.appendChild(divCopy);
    modelDiv.appendChild(divModelImg);
    document.body.append(modelDiv);
    if (modelDiv) {
      modelDiv.style.display = "block";
      links.style.display = window.innerWidth <= 768 ? "none" : "block";
      blurCon.style.display = "none";
    }
    const shareCodeUrl = document.querySelector(".share-code");
    if (shareCodeUrl) {
      shareCodeUrl.addEventListener("click", copyShareCode);
    }
    flag = false;
  }

  divCloseX.addEventListener("click", () => (modelDiv.style.display = "none"));

  const closeX = document.createElement("span");
  closeX.innerHTML = "&times;";
  closeX.classList.add("closeX");

  menu.addEventListener("click", (e) => {
    e.stopPropagation();
    flag = !flag;

    if (flag) {
      links.style.display = "block";
      blurCon.style.display = "block";
      const sidebar = document.getElementById("language-sidebar");
      if (sidebar) sidebar.classList.add("mobile-open");
      links.insertAdjacentElement("afterbegin", closeX);
      closeX.addEventListener("click", hideLinks, { once: true });
    } else {
      hideLinks();
    }
  });

  blurCon.addEventListener("click", (e) => {
    if (e.target === blurCon) {
      hideLinks();
    }
  });

  function hideLinks() {
    links.style.display = "none";
    blurCon.style.display = "none";
    const sidebar = document.getElementById("language-sidebar");
    if (sidebar) sidebar.classList.remove("mobile-open");
    flag = false;
    if (closeX) closeX.remove();
  }

  let predictionInterval;
  let loadingTimeout;

  function showLoading(
    show,
    message = "Loading...",
    showProgress = false,
    type = null,
  ) {
    const loaderParent = document.querySelector(".loader-parent");
    const topContainer = document.getElementById("top-progress-container");
    const topBar = document.getElementById("top-progress-bar");
    const statusOverlay = document.getElementById("ai-status-overlay");
    const statusText = document.getElementById("ai-status-text");
    const statusTimer = document.getElementById("ai-status-timer");
    const progressBar = document.getElementById("ai-progress-bar");
    const progressContainer = document.querySelector(".progress-container");

    clearTimeout(loadingTimeout);

    if (!show) {
      stopProgressBar();
      clearInterval(predictionInterval);

      if (topContainer && topContainer.style.display === "block") {
        if (topBar) topBar.style.width = "100%";
        if (progressBar) progressBar.style.width = "100%";
        if (statusTimer) statusTimer.textContent = "(0s)";

        setTimeout(() => {
          if (loaderParent) loaderParent.style.display = "none";
          if (topContainer) topContainer.style.display = "none";
          if (statusOverlay) statusOverlay.style.display = "none";
          if (topBar) topBar.style.width = "0%";
          if (progressBar) progressBar.style.width = "0%";
          if (progressContainer) progressContainer.style.display = "none";
        }, 600);
      } else {
        if (loaderParent) loaderParent.style.display = "none";
        if (topContainer) topContainer.style.display = "none";
        if (statusOverlay) statusOverlay.style.display = "none";
        if (topBar) topBar.style.width = "0%";
        if (progressBar) progressBar.style.width = "0%";
        if (progressContainer) progressContainer.style.display = "none";
      }
      return;
    }

    loadingTimeout = setTimeout(() => {
      if (!showProgress) {
        if (loaderParent) loaderParent.style.display = "block";
        const titleEl = document.querySelector(".loader-container .title");
        if (titleEl) titleEl.textContent = message;
      }
    }, 600);

    if (showProgress) {
      const progressBar = document.getElementById("ai-progress-bar");
      const progressContainer = document.querySelector(".progress-container");

      if (progressContainer) progressContainer.style.display = "block";

      if (topContainer) topContainer.style.display = "block";
      if (statusOverlay) statusOverlay.style.display = "flex";
      if (statusText) statusText.textContent = message;
      animateProgressBar(progressBar, topBar);
      if (type) startPrediction(type, statusTimer);
    }
  }

  function startPrediction(type, el) {
    if (!el) return;

    clearInterval(predictionInterval);

    const estimates = {
      fix: 20,
      write: 30,
      run: 10,
      default: 25,
    };

    const estimatedSeconds = estimates[type] || estimates.default;
    const startedAt = Date.now();

    function updatePrediction() {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      const remaining = estimatedSeconds - elapsed;

      if (remaining > 10) {
        el.textContent = `(~${remaining}s)`;
      } else if (remaining > 3) {
        el.textContent = `(${remaining}s)`;
      } else if (remaining > 0) {
        el.textContent = `(almost done)`;
      } else {
        el.textContent = `(still working...)`;
      }
    }
    updatePrediction();
    predictionInterval = setInterval(updatePrediction, 1000);
  }

  let progressInterval;
  function animateProgressBar(bar, topBar) {
    let width = 0;
    if (bar) bar.style.width = "0%";
    if (topBar) topBar.style.width = "0%";

    stopProgressBar();

    progressInterval = setInterval(() => {
      if (width >= 90) {
        width += (95 - width) * 0.05;
      } else if (width >= 70) {
        width += 0.5;
      } else {
        width += 2;
      }
      if (bar) bar.style.width = width + "%";
      if (topBar) topBar.style.width = width + "%";
    }, 200);
  }

  function stopProgressBar() {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
  }

  function isMobile() {
    if (!links || !blurCon || !closeX) return;
    if (window.innerWidth > 768) {
      links.style.display = "flex";
      closeX.style.display = "none";
      blurCon.style.display = "none";
      flag = false;
    } else {
      links.style.display = "none";
      closeX.style.display = "block";
      blurCon.style.display = "none";
    }
  }

  function responsive() {
    if (window.innerWidth > 768) {
      editorView = 0;
      outputBtn.style.background = "";
      outputBtn.style.color = "";
      fullEditor.style.background = "";
      editorContainer.style.width = "52%";
      outputContainer.style.width = "48%";
      editorContainer.style.height = "100%";
      outputContainer.style.height = "100%";
      editorContainer.style.display = "block";
      outputContainer.style.display = "block";
      editorContainer.classList.remove("editor-fullscreen");
      outputContainer.classList.remove("output-fullscreen");
      toggleViewBtn.innerHTML =
        '<i class="fas fa-exchange-alt"></i><span class="hidden-mobile">Switch</span>';
    } else {
      if (editorView === 0) {
        editorView = 1;
      }

      if (editorView === 1) {
        showFullEditor();
      } else if (editorView === 2) {
        showOutput();
      }
    }

    isMobile();
    editor.refresh();
    setTimeout(() => safeFit(), 10);
  }

  function smoothScrollEditorToTop(cm) {
    const scroller = cm.getScrollerElement();

    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({
        top: 0,
        behavior: "smooth",
      });
    } else {
      scroller.scrollTop = 0;
    }
  }

  let typingRunId = 0;
  function typeCodeIntoEditor(code, cm) {
    const runId = ++typingRunId;

    return new Promise((resolve) => {
      cm.operation(() => {
        cm.setValue("");
        cm.setCursor({ line: 0, ch: 0 });
      });

      let index = 0;

      const charsPerFrame = 1;
      const frameDelay = 6;

      function type() {
        if (runId !== typingRunId) {
          resolve();
          return;
        }

        if (index >= code.length) {
          cm.refresh();

          setTimeout(() => {
            if (runId === typingRunId) {
              smoothScrollEditorToTop(cm);
            }

            resolve();
          }, 300);

          return;
        }

        const nextIndex = Math.min(index + charsPerFrame, code.length);
        const chunk = code.slice(index, nextIndex);

        cm.operation(() => {
          const from = cm.posFromIndex(index);
          cm.replaceRange(chunk, from);

          index = nextIndex;

          cm.setCursor(cm.posFromIndex(index));
        });

        setTimeout(type, frameDelay);
      }

      setTimeout(type, 60);
    });
  }

  responsive();
  window.addEventListener("resize", responsive);

  // --- View switching ---
  function showFullEditor() {
    if (window.innerWidth > 768) return;

    editorView = 1;
    outputBtn.style.background = "";
    outputBtn.style.color = "";
    fullEditor.style.background = "";
    editorContainer.style.display = "block";
    editorContainer.classList.add("editor-fullscreen");
    outputContainer.style.display = "none";
    outputContainer.classList.remove("output-fullscreen");
    toggleViewBtn.innerHTML =
      '<i class="fas fa-code"></i><span class="hidden-mobile">Switch</span>';
    editorContainer.style.width = "100%";
    outputContainer.style.width = "0%";
    editorContainer.style.height = "100%";
    outputContainer.style.height = "0%";
    editor.refresh();
  }

  function showOutput() {
    if (window.innerWidth > 768) return;

    editorView = 2;
    outputBtn.style.background = "darkviolet";
    outputBtn.style.color = "#f8f8f8";
    fullEditor.style.background = "";
    editorContainer.style.display = "none";
    editorContainer.classList.remove("editor-fullscreen");
    outputContainer.style.display = "block";
    outputContainer.classList.add("output-fullscreen");
    toggleViewBtn.innerHTML =
      '<i class="fas fa-terminal"></i><span class="hidden-mobile">Switch</span>';
    editorContainer.style.width = "0%";
    outputContainer.style.width = "100%";
    editorContainer.style.height = "0%";
    outputContainer.style.height = "100%";

    setTimeout(() => safeFit(), 10);
  }

  fullEditor.addEventListener("click", showFullEditor);
  outputBtn.addEventListener("click", showOutput);

  // --- Toggle View ---
  toggleViewBtn.addEventListener("click", () => {
    editorView++;

    if (editorView > 2) {
      editorView = 0;
    }

    if (editorView === 1) {
      outputBtn.style.background = "";
      outputBtn.style.color = "";
      fullEditor.style.background = "";
      editorContainer.style.display = "block";
      editorContainer.classList.add("editor-fullscreen");
      outputContainer.style.display = "none";
      outputContainer.classList.remove("output-fullscreen");
      toggleViewBtn.innerHTML =
        '<i class="fas fa-code"></i><span class="hidden-mobile">Switch</span>';
      editorContainer.style.width = "100%";
      outputContainer.style.width = "0%";
      editorContainer.style.height = "100%";
      outputContainer.style.height = "0%";
      dragbarVertical.style.display = "none";
    } else if (editorView === 2) {
      outputBtn.style.background = "darkviolet";
      outputBtn.style.color = "#f8f8f8";
      fullEditor.style.background = "";
      editorContainer.style.display = "none";
      editorContainer.classList.remove("editor-fullscreen");
      outputContainer.style.display = "block";
      outputContainer.classList.add("output-fullscreen");
      toggleViewBtn.innerHTML =
        '<i class="fas fa-terminal"></i><span class="hidden-mobile">Switch</span>';
      editorContainer.style.width = "0%";
      outputContainer.style.width = "100%";
      editorContainer.style.height = "0%";
      outputContainer.style.height = "100%";
      dragbarVertical.style.display = "none";
    } else {
      outputBtn.style.background = "";
      outputBtn.style.color = "";
      fullEditor.style.background = "";
      editorContainer.style.display = "block";
      outputContainer.style.display = "block";
      dragbarVertical.style.display = "block";
      editorContainer.classList.remove("editor-fullscreen");
      outputContainer.classList.remove("output-fullscreen");
      toggleViewBtn.innerHTML =
        '<i class="fas fa-exchange-alt"></i><span class="hidden-mobile">Switch</span>';

      if (window.innerWidth <= 768) {
        editorContainer.style.width = "100%";
        outputContainer.style.width = "100%";
        editorContainer.style.height = "52%";
        outputContainer.style.height = "48%";
      } else {
        editorContainer.style.width = "52%";
        outputContainer.style.width = "48%";
        editorContainer.style.height = "100%";
        outputContainer.style.height = "100%";
      }
    }

    editor.refresh();
    setTimeout(() => safeFit(), 10);
  });

  if (aiFixBtn) {
    aiFixBtn.addEventListener("click", async () => {
      const code = editor.getValue();
      if (!lastCompileError) {
        showToast("No error to fix", true);
        return;
      }

      aiFixBtn.style.display = "none";
      showLoading(true, "AI Fix in Progress", true, "fix");

      try {
        const res = await fetch("/api/ai/fix-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            error: lastCompileError,
            language: currentLanguage,
          }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || "AI fix failed", true);
          aiFixBtn.style.display = "flex";
          showLoading(false);
          return;
        }

        showLoading(false);
        editor.setValue(data.fixedCode);
        lastCompileError = "";
        showToast("Code fixed by AI! Review the changes and run again.");

        if (window.innerWidth <= 768) {
          showFullEditor();
        }
      } catch (err) {
        showToast("AI service error. Please try again.", true);
        aiFixBtn.style.display = "flex";
        showLoading(false);
      }
    });
  }

  const aiWriteBtn = document.getElementById("ai-write-btn");
  const aiWriteModal = document.getElementById("ai-write-modal");
  const aiWriteClose = document.getElementById("ai-write-close");
  const aiWriteForm = document.getElementById("ai-write-form");
  const aiWriteSubmit = document.getElementById("ai-write-submit");
  const aiWritePrompt = document.getElementById("ai-write-prompt");
  const aiCharCount = document.getElementById("ai-char-count");

  function updateAiCharCount() {
    if (aiCharCount && aiWritePrompt) {
      aiCharCount.textContent = `${aiWritePrompt.value.length}/500`;
    }
  }

  function openAiWriteModal() {
    aiWriteModal.style.display = "flex";
    if (window.innerWidth <= 768) hideLinks();
    if (aiWritePrompt) {
      if (!aiWritePrompt.value) {
        aiWritePrompt.value = sessionStorage.getItem("aiLastPrompt") || "";
      }
      updateAiCharCount();
      aiWritePrompt.focus();
      aiWritePrompt.select();
    }
  }

  function closeAiWriteModal() {
    aiWriteModal.style.display = "none";
  }

  if (aiWriteBtn) {
    aiWriteBtn.addEventListener("click", openAiWriteModal);
  }

  if (aiWriteClose) {
    aiWriteClose.addEventListener("click", closeAiWriteModal);
  }

  if (aiWriteModal) {
    aiWriteModal.addEventListener("click", (e) => {
      if (e.target === aiWriteModal) {
        closeAiWriteModal();
      }
    });
  }

  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      aiWriteModal &&
      aiWriteModal.style.display === "flex"
    ) {
      closeAiWriteModal();
    }
  });

  if (aiWritePrompt) {
    aiWritePrompt.addEventListener("input", updateAiCharCount);
    aiWritePrompt.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        closeAiWriteModal();
      }
    });
  }

  function filenameFromPrompt(promptText) {
    const slug = promptText
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("_");
    const ext = (LANG_CONFIG[currentLanguage]?.filename || "main.txt")
      .split(".")
      .pop();
    return `${slug || "ai_generated"}.${ext}`;
  }

  if (aiWriteForm) {
    aiWriteForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const promptText = aiWritePrompt.value.trim();
      if (!promptText) return;
      sessionStorage.setItem("aiLastPrompt", promptText);

      aiWriteSubmit.disabled = true;
      aiWriteSubmit.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Generating...';

      aiWriteModal.style.display = "none";
      showLoading(true, "AI Code Generation", true, "write");

      try {
        const res = await fetch("/api/ai/write-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: promptText,
            language: currentLanguage,
          }),
        });
        const data = await res.json();

        if (!res.ok) {
          showToast(data.error || "AI generation failed", true);
          showLoading(false);
          return;
        }
        showLoading(false);
        const aiFileName = filenameFromPrompt(promptText);
        fileNameEditor.textContent = aiFileName;
        document.querySelector("title").textContent = aiFileName;
        await typeCodeIntoEditor(data.code, editor);
        if (currentLanguage === "html") {
          showHtmlPreview(data.code);
        }
        aiWriteModal.style.display = "none";
        aiWritePrompt.value = "";
        sessionStorage.removeItem("aiLastPrompt");
        updateAiCharCount();
        showToast("Code generated by AI! Review and run it.");

        if (window.innerWidth <= 768) {
          showFullEditor();
        }
      } catch (err) {
        showToast("AI service error. Please try again.", true);
        showLoading(false);
      } finally {
        aiWriteSubmit.disabled = false;
        aiWriteSubmit.innerHTML =
          '<i class="fas fa-wand-magic-sparkles"></i> Generate Code';
      }
    });
  }

  //pratice timer
  const timerToggle = document.getElementById("timer-toggle");
  const timerReset = document.getElementById("timer-reset");
  const timerDisplay = document.getElementById("practice-timer");
  let timerInterval = null;
  let timerSeconds = parseInt(
    sessionStorage.getItem("timerSeconds") || "0",
    10,
  );
  let timerRunning = sessionStorage.getItem("timerRunning") === "true";

  function updateTimerDisplay() {
    const mins = Math.floor(timerSeconds / 60)
      .toString()
      .padStart(2, "0");
    const secs = (timerSeconds % 60).toString().padStart(2, "0");
    timerDisplay.textContent = `${mins}:${secs}`;
  }

  function startTimer() {
    timerRunning = true;
    sessionStorage.setItem("timerRunning", "true");
    timerToggle.classList.add("timer-active");
    timerToggle.querySelector("i").className = "fas fa-pause";
    timerInterval = setInterval(() => {
      timerSeconds++;
      sessionStorage.setItem("timerSeconds", timerSeconds.toString());
      updateTimerDisplay();
    }, 1000);
  }

  function pauseTimer() {
    timerRunning = false;
    sessionStorage.setItem("timerRunning", "false");
    timerToggle.classList.remove("timer-active");
    timerToggle.querySelector("i").className = "fas fa-stopwatch";
    clearInterval(timerInterval);
    timerInterval = null;
  }

  if (timerToggle) {
    timerToggle.addEventListener("click", () => {
      if (timerRunning) {
        pauseTimer();
      } else {
        startTimer();
      }
    });
  }

  if (timerReset) {
    timerReset.addEventListener("click", () => {
      pauseTimer();
      timerSeconds = 0;
      sessionStorage.setItem("timerSeconds", "0");
      updateTimerDisplay();
    });
  }

  updateTimerDisplay();
  if (timerRunning) {
    startTimer();
  }
}

document.addEventListener("DOMContentLoaded", init);
