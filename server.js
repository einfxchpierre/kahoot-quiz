const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 15506;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("The hosting provider must set a valid PORT environment variable.");
}
const DEFAULT_DURATION_SECONDS = 30;
const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 300;
const MAX_PLAYERS = 30;
const MAX_QUESTIONS = 50;
const MAX_QUIZZES = 50;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "leon.batzel";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1121";

const PUBLIC_DIR = path.join(__dirname, "public");
// Hier werden die Quizze und die hochgeladenen Bilder gespeichert.
// Mit DATA_DIR kann ein dauerhafter Speicherort des Hostings angegeben werden.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const QUIZZES_FILE = path.join(DATA_DIR, "quizzes.json");
const OLD_QUESTIONS_FILE = path.join(DATA_DIR, "questions.json");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_URL_PATTERN = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/;
const DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
const CODE_PATTERN = /^[A-Z0-9]{3,10}$/;
// Ohne leicht verwechselbare Zeichen (0/O, 1/I)
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ---------- Fragen und Quizze: prüfen, laden, speichern ---------- */

function validateQuestions(list) {
  const fail = (error) => ({ ok: false, error });
  if (!Array.isArray(list)) return fail("Ungültige Fragenliste.");
  if (list.length > MAX_QUESTIONS) return fail("Es sind maximal " + MAX_QUESTIONS + " Fragen pro Quiz möglich.");

  const questions = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] && typeof list[i] === "object" ? list[i] : {};
    const label = "Frage " + (i + 1) + ": ";

    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) return fail(label + "Der Fragetext fehlt.");
    if (text.length > 400) return fail(label + "Der Fragetext ist zu lang (maximal 400 Zeichen).");

    const options = Array.isArray(item.options)
      ? item.options.map((option) => (typeof option === "string" ? option.trim() : ""))
      : [];
    if (options.length < 1 || options.length > 4) return fail(label + "Es braucht 1 bis 4 Antworten.");
    if (options.some((option) => !option)) return fail(label + "Eine Antwort ist noch leer.");
    if (options.some((option) => option.length > 200)) return fail(label + "Eine Antwort ist zu lang (maximal 200 Zeichen).");

    // Neues Format: correctIndices (mehrere richtige Antworten). Altes Format: correctIndex.
    let correctIndices = item.correctIndices;
    if (correctIndices === undefined && Number.isInteger(item.correctIndex)) correctIndices = [item.correctIndex];
    if (!Array.isArray(correctIndices) || !correctIndices.length
      || correctIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= options.length)) {
      return fail(label + "Markiere mindestens eine richtige Antwort.");
    }
    correctIndices = [...new Set(correctIndices)].sort((a, b) => a - b);

    const duration = item.duration === undefined ? DEFAULT_DURATION_SECONDS : item.duration;
    if (!Number.isInteger(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
      return fail(label + "Die Zeit muss zwischen " + MIN_DURATION_SECONDS + " und " + MAX_DURATION_SECONDS + " Sekunden liegen.");
    }

    const image = typeof item.image === "string" ? item.image : "";
    if (image && !IMAGE_URL_PATTERN.test(image)) return fail(label + "Das Bild ist ungültig. Lade es bitte neu hoch.");

    questions.push({ text, options, correctIndices, duration, image });
  }
  return { ok: true, questions };
}

function validateQuizName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { ok: false, error: "Gib dem Quiz bitte einen Namen." };
  if (name.length > 60) return { ok: false, error: "Der Name ist zu lang (maximal 60 Zeichen)." };
  return { ok: true, name };
}

function normalizeCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function generateCode(existingQuizzes) {
  for (;;) {
    let code = "";
    for (let i = 0; i < 5; i += 1) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!existingQuizzes.some((quiz) => quiz.code === code)) return code;
  }
}

function newId() {
  return crypto.randomBytes(6).toString("hex");
}

function loadQuizzes() {
  const quizzes = [];

  try {
    const parsed = JSON.parse(fs.readFileSync(QUIZZES_FILE, "utf8"));
    for (const item of Array.isArray(parsed.quizzes) ? parsed.quizzes : []) {
      const nameResult = validateQuizName(item && item.name);
      const questionsResult = validateQuestions(item && item.questions);
      if (!nameResult.ok || !questionsResult.ok) {
        console.warn("Ein gespeichertes Quiz ist ungültig und wird übersprungen.");
        continue;
      }
      const code = normalizeCode(item.code);
      quizzes.push({
        id: typeof item.id === "string" && item.id ? item.id : newId(),
        name: nameResult.name,
        code: CODE_PATTERN.test(code) && !quizzes.some((quiz) => quiz.code === code) ? code : generateCode(quizzes),
        questions: questionsResult.questions,
      });
    }
    return quizzes;
  } catch {
    // Noch nichts gespeichert: weiter mit der Übernahme alter Daten oder den Start-Fragen.
  }

  let questions = null;
  try {
    const old = validateQuestions(JSON.parse(fs.readFileSync(OLD_QUESTIONS_FILE, "utf8")));
    if (old.ok) questions = old.questions;
  } catch {
    // Keine alte Datei vorhanden.
  }
  if (!questions) {
    const seed = validateQuestions(require("./questions"));
    questions = seed.ok ? seed.questions : [];
  }
  quizzes.push({ id: newId(), name: "Fremdwörter-Quiz", code: generateCode(quizzes), questions });
  return quizzes;
}

function cleanupUploads() {
  const used = new Set();
  for (const quiz of quizzes) {
    for (const question of quiz.questions) if (question.image) used.add(path.basename(question.image));
  }
  for (const file of fs.readdirSync(UPLOAD_DIR)) {
    if (used.has(file)) continue;
    const fullPath = path.join(UPLOAD_DIR, file);
    try {
      // Frisch hochgeladene Bilder, die noch nicht gespeichert wurden, bleiben eine Stunde erhalten.
      if (Date.now() - fs.statSync(fullPath).mtimeMs > 3_600_000) fs.unlinkSync(fullPath);
    } catch {
      // Ignorieren: die Datei ist schon weg.
    }
  }
}

function persistQuizzes() {
  const data = { quizzes: quizzes.map(({ id, name, code, questions }) => ({ id, name, code, questions })) };
  const tempFile = QUIZZES_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, QUIZZES_FILE);
  cleanupUploads();
}

/* ---------- Spielzustand (je Quiz eine eigene Runde) ---------- */

function newGame() {
  return { status: "waiting", queue: [], players: [], questionIndex: -1, timer: null, deadline: null };
}

const quizzes = loadQuizzes();
quizzes.forEach((quiz) => { quiz.game = newGame(); });
try {
  persistQuizzes();
} catch (error) {
  console.error("Quizze konnten nicht gespeichert werden:", error.message);
}

function clearGameTimer(game) {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

function scheduleQuestionTimeout(quiz) {
  const game = quiz.game;
  const duration = quiz.questions[game.questionIndex].duration * 1000;
  game.deadline = Date.now() + duration;
  game.timer = setTimeout(() => advanceQuestion(quiz), duration);
}

function advanceQuestion(quiz) {
  const game = quiz.game;
  clearGameTimer(game);

  if (game.status !== "playing") return;
  if (game.questionIndex + 1 >= quiz.questions.length) {
    game.status = "finished";
    game.deadline = null;
    return;
  }

  game.questionIndex += 1;
  game.players.forEach((player) => { player.answered = false; });
  scheduleQuestionTimeout(quiz);
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  response.end(JSON.stringify(data));
}

function getPublicState(quiz, deviceId) {
  const game = quiz.game;
  const question = game.status === "playing" ? quiz.questions[game.questionIndex] : null;
  const nextQuestion = game.status === "playing" ? quiz.questions[game.questionIndex + 1] : null;
  const standings = [...game.players].sort((a, b) => b.score - a.score);
  const joinedPlayer = [...game.queue, ...game.players].find((player) => player.deviceId === deviceId);
  return {
    quizName: quiz.name,
    code: quiz.code,
    status: game.status,
    deviceJoined: Boolean(joinedPlayer),
    joinedName: joinedPlayer ? joinedPlayer.name : "",
    maxPlayers: MAX_PLAYERS,
    queue: game.queue.map(({ name }) => ({ name })),
    players: standings.map(({ name, score, answered }) => ({ name, score, answered })),
    questionCount: quiz.questions.length,
    question: question
      ? {
          text: question.text,
          options: question.options,
          image: question.image || "",
          multiple: question.correctIndices.length > 1,
          number: game.questionIndex + 1,
          total: quiz.questions.length,
          durationMs: question.duration * 1000,
          msRemaining: Math.max(0, game.deadline - Date.now()),
        }
      : null,
    nextImage: nextQuestion ? nextQuestion.image || "" : "",
    answeredCount: game.players.filter((player) => player.answered).length,
    podium: game.status === "finished" ? standings.slice(0, 3).map(({ name, score }) => ({ name, score })) : [],
  };
}

function summarizeQuiz(quiz) {
  return {
    id: quiz.id,
    name: quiz.name,
    code: quiz.code,
    questionCount: quiz.questions.length,
    status: quiz.game.status,
    queueCount: quiz.game.queue.length,
    playerCount: quiz.game.players.length,
  };
}

function findQuizByCode(body) {
  const code = normalizeCode(body.code);
  return code ? quizzes.find((quiz) => quiz.code === code) || null : null;
}

// Admin-Aktionen dürfen das Quiz über die ID oder (z. B. beim "Ende"-Knopf) über den Code finden.
function findQuizForAdmin(body) {
  if (typeof body.id === "string") return quizzes.find((quiz) => quiz.id === body.id) || null;
  return findQuizByCode(body);
}

/* ---------- Admin ---------- */

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function checkAdmin(body) {
  return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD
    && safeEqual(body.email, ADMIN_EMAIL) && safeEqual(body.password, ADMIN_PASSWORD));
}

function authorizeAdmin(body, response) {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    sendJson(response, 503, { error: "Der Admin-Zugang ist beim Hosting noch nicht eingerichtet." });
    return false;
  }
  if (!checkAdmin(body)) {
    sendJson(response, 403, { error: "E-Mail oder Passwort stimmt nicht." });
    return false;
  }
  return true;
}

function saveOrFail(response, message) {
  try {
    persistQuizzes();
    return true;
  } catch (error) {
    console.error(message, error.message);
    sendJson(response, 500, { error: "Das konnte nicht gespeichert werden." });
    return false;
  }
}

/* ---------- Anfragen ---------- */

function readBody(request, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > limit) {
        tooLarge = true;
        body = "";
      }
    });
    request.on("end", () => {
      if (tooLarge) return reject(new Error("Die Anfrage ist zu groß."));
      try {
        const parsed = JSON.parse(body || "{}");
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error("Ungültige Anfrage."));
      }
    });
    request.on("error", reject);
  });
}

function bodyLimitFor(pathname) {
  if (pathname === "/api/admin/upload") return 5_000_000;
  if (pathname === "/api/admin/save") return 400_000;
  return 100_000;
}

async function handleApi(request, response, pathname) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Diese Aktion ist nicht verfügbar." });
  }

  let body;
  try {
    body = await readBody(request, bodyLimitFor(pathname));
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }

  /* --- Mitspielen --- */

  if (["/api/state", "/api/join", "/api/answer"].includes(pathname)) {
    const quiz = findQuizByCode(body);
    if (!quiz) return sendJson(response, 404, { error: "Diesen Quiz-Code gibt es nicht. Prüfe den Code bitte noch einmal." });
    const game = quiz.game;

    if (pathname === "/api/state") {
      return sendJson(response, 200, getPublicState(quiz, body.deviceId));
    }

    if (pathname === "/api/join") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 18) : "";
      if (!name) return sendJson(response, 400, { error: "Gib bitte einen Namen ein." });
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      if (!/^[a-f0-9-]{36}$/i.test(deviceId)) {
        return sendJson(response, 400, { error: "Gerätekennung fehlt. Lade die Seite neu." });
      }
      if ([...game.queue, ...game.players].some((player) => player.deviceId === deviceId)) {
        return sendJson(response, 409, { error: "Von diesem Gerät bist du schon dabei." });
      }
      const allNames = [...game.queue, ...game.players].map((player) => player.name.toLowerCase());
      if (allNames.includes(name.toLowerCase())) {
        return sendJson(response, 409, { error: "Der Name ist schon dabei. Nimm bitte einen anderen." });
      }
      if (game.queue.length + game.players.length >= MAX_PLAYERS) {
        return sendJson(response, 400, { error: "Die Runde ist voll (maximal " + MAX_PLAYERS + " Leute)." });
      }
      game.queue.push({ name, deviceId });
      return sendJson(response, 200, { ok: true });
    }

    // /api/answer
    if (game.status !== "playing") return sendJson(response, 400, { error: "Gerade läuft keine Frage." });
    if (Date.now() >= game.deadline) advanceQuestion(quiz);
    if (game.status !== "playing") return sendJson(response, 400, { error: "Die Runde ist schon vorbei." });
    if (body.questionNumber !== game.questionIndex + 1) {
      return sendJson(response, 409, { error: "Diese Frage ist schon vorbei. Die nächste wird geladen." });
    }
    const player = game.players.find((item) => item.deviceId === body.deviceId);
    if (!player) return sendJson(response, 404, { error: "Du bist nicht in dieser Runde." });
    if (player.answered) return sendJson(response, 400, { error: "Du hast schon geantwortet." });

    const question = quiz.questions[game.questionIndex];
    const answers = Array.isArray(body.answers) ? body.answers : Number.isInteger(body.answer) ? [body.answer] : [];
    const unique = [...new Set(answers)];
    if (!unique.length || unique.length !== answers.length
      || unique.some((index) => !Number.isInteger(index) || index < 0 || index >= question.options.length)) {
      return sendJson(response, 400, { error: "Diese Antwort gibt es nicht." });
    }
    // Punkte gibt es nur, wenn genau die richtigen Antworten gewählt wurden.
    const isRight = unique.length === question.correctIndices.length
      && unique.every((index) => question.correctIndices.includes(index));
    if (isRight) player.score += 100;
    player.answered = true;
    if (game.players.every((item) => item.answered)) advanceQuestion(quiz);
    return sendJson(response, 200, { ok: true });
  }

  /* --- Runde steuern (Admin) --- */

  if (pathname === "/api/start" || pathname === "/api/reset") {
    if (!authorizeAdmin(body, response)) return;
    const quiz = findQuizForAdmin(body);
    if (!quiz) return sendJson(response, 404, { error: "Dieses Quiz gibt es nicht." });
    const game = quiz.game;

    if (pathname === "/api/start") {
      if (game.status === "playing") return sendJson(response, 400, { error: "Die Runde läuft schon." });
      if (!game.queue.length) return sendJson(response, 400, { error: "Noch wartet niemand in der Warteschlange." });
      if (!quiz.questions.length) return sendJson(response, 400, { error: "Füge zuerst mindestens eine Frage hinzu." });
      game.players = game.queue.map(({ name, deviceId }) => ({ name, deviceId, score: 0, answered: false }));
      game.queue = [];
      game.questionIndex = 0;
      game.status = "playing";
      scheduleQuestionTimeout(quiz);
      return sendJson(response, 200, { ok: true });
    }

    clearGameTimer(game);
    game.deadline = null;
    game.status = "waiting";
    game.players = [];
    game.questionIndex = -1;
    return sendJson(response, 200, { ok: true });
  }

  /* --- Quizze verwalten (Admin) --- */

  if (pathname === "/api/admin/quizzes") {
    if (!authorizeAdmin(body, response)) return;
    return sendJson(response, 200, { quizzes: quizzes.map(summarizeQuiz) });
  }

  if (pathname === "/api/admin/quiz") {
    if (!authorizeAdmin(body, response)) return;
    const quiz = findQuizForAdmin(body);
    if (!quiz) return sendJson(response, 404, { error: "Dieses Quiz gibt es nicht." });
    return sendJson(response, 200, { quiz: { id: quiz.id, name: quiz.name, code: quiz.code, questions: quiz.questions } });
  }

  if (pathname === "/api/admin/create") {
    if (!authorizeAdmin(body, response)) return;
    if (quizzes.length >= MAX_QUIZZES) return sendJson(response, 400, { error: "Es sind maximal " + MAX_QUIZZES + " Quizze möglich." });
    const nameResult = validateQuizName(body.name === undefined ? "Neues Quiz" : body.name);
    if (!nameResult.ok) return sendJson(response, 400, { error: nameResult.error });
    const quiz = { id: newId(), name: nameResult.name, code: generateCode(quizzes), questions: [], game: newGame() };
    quizzes.push(quiz);
    if (!saveOrFail(response, "Quiz konnte nicht gespeichert werden:")) {
      quizzes.pop();
      return;
    }
    return sendJson(response, 200, { ok: true, quiz: { id: quiz.id, name: quiz.name, code: quiz.code, questions: quiz.questions } });
  }

  if (pathname === "/api/admin/save") {
    if (!authorizeAdmin(body, response)) return;
    const quiz = findQuizForAdmin(body);
    if (!quiz) return sendJson(response, 404, { error: "Dieses Quiz gibt es nicht." });
    if (quiz.game.status === "playing") {
      return sendJson(response, 409, { error: "Die Runde läuft gerade. Beende sie zuerst, dann kannst du speichern." });
    }
    const nameResult = validateQuizName(body.name);
    if (!nameResult.ok) return sendJson(response, 400, { error: nameResult.error });
    const questionsResult = validateQuestions(body.questions);
    if (!questionsResult.ok) return sendJson(response, 400, { error: questionsResult.error });

    const previous = { name: quiz.name, questions: quiz.questions };
    quiz.name = nameResult.name;
    quiz.questions = questionsResult.questions;
    if (!saveOrFail(response, "Quiz konnte nicht gespeichert werden:")) {
      quiz.name = previous.name;
      quiz.questions = previous.questions;
      return;
    }
    return sendJson(response, 200, { ok: true, quiz: { id: quiz.id, name: quiz.name, code: quiz.code, questions: quiz.questions } });
  }

  if (pathname === "/api/admin/newcode") {
    if (!authorizeAdmin(body, response)) return;
    const quiz = findQuizForAdmin(body);
    if (!quiz) return sendJson(response, 404, { error: "Dieses Quiz gibt es nicht." });
    if (quiz.game.status === "playing") return sendJson(response, 409, { error: "Die Runde läuft gerade. Der Code kann danach geändert werden." });
    const previousCode = quiz.code;
    quiz.code = generateCode(quizzes);
    if (!saveOrFail(response, "Code konnte nicht gespeichert werden:")) {
      quiz.code = previousCode;
      return;
    }
    return sendJson(response, 200, { ok: true, code: quiz.code });
  }

  if (pathname === "/api/admin/delete") {
    if (!authorizeAdmin(body, response)) return;
    const quiz = findQuizForAdmin(body);
    if (!quiz) return sendJson(response, 404, { error: "Dieses Quiz gibt es nicht." });
    if (quiz.game.status === "playing") return sendJson(response, 409, { error: "Die Runde läuft gerade. Beende sie zuerst." });
    clearGameTimer(quiz.game);
    quizzes.splice(quizzes.indexOf(quiz), 1);
    if (!saveOrFail(response, "Quiz konnte nicht gelöscht werden:")) {
      quizzes.push(quiz);
      return;
    }
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/admin/upload") {
    if (!authorizeAdmin(body, response)) return;
    const match = typeof body.dataUrl === "string" ? DATA_URL_PATTERN.exec(body.dataUrl) : null;
    if (!match) {
      return sendJson(response, 400, { error: "Dieses Bild wird nicht unterstützt (erlaubt: PNG, JPG, WebP, GIF)." });
    }
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 3_000_000) {
      return sendJson(response, 400, { error: "Das Bild ist zu groß (maximal 3 MB)." });
    }
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const fileName = crypto.randomBytes(16).toString("hex") + "." + extension;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
    } catch (error) {
      console.error("Bild konnte nicht gespeichert werden:", error.message);
      return sendJson(response, 500, { error: "Das Bild konnte nicht gespeichert werden." });
    }
    return sendJson(response, 200, { ok: true, url: "/uploads/" + fileName });
  }

  return sendJson(response, 404, { error: "Diese Seite gibt es nicht." });
}

function serveFile(response, baseDir, relativePath, extraHeaders) {
  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    response.writeHead(400);
    return response.end("Ungültiger Pfad.");
  }
  const filePath = path.resolve(baseDir, decoded);
  if (!filePath.startsWith(baseDir + path.sep)) {
    response.writeHead(403);
    return response.end("Nicht erlaubt.");
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404);
      return response.end("Datei nicht gefunden.");
    }
    const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "text/plain; charset=utf-8";
    response.writeHead(200, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff", ...extraHeaders });
    response.end(contents);
  });
}

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url, "http://localhost").pathname;
  } catch {
    response.writeHead(400);
    return response.end("Ungültige Anfrage.");
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(request, response, pathname).catch((error) => {
      console.error("Fehler in der API:", error);
      if (!response.headersSent) sendJson(response, 500, { error: "Da ist etwas schiefgelaufen." });
    });
  }

  if (pathname.startsWith("/uploads/")) {
    return serveFile(response, UPLOAD_DIR, pathname.slice("/uploads/".length), {
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  }

  return serveFile(response, PUBLIC_DIR, pathname === "/" ? "index.html" : pathname.slice(1), {
    "Cache-Control": "no-cache",
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Quiz-Ecke ist gestartet.");
});
