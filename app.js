/* SkillTester Exam Portal: client orchestration and Firebase integration. */
const firebaseConfig = {
  apiKey: "AIzaSyBtU4FbqMwIQL2WyOUVhn5o4NiP8r53EQs",
  authDomain: "live-feedback-app-7bf6b.firebaseapp.com",
  databaseURL: "https://live-feedback-app-7bf6b-default-rtdb.firebaseio.com",
  projectId: "live-feedback-app-7bf6b",
  storageBucket: "live-feedback-app-7bf6b.firebasestorage.app",
  messagingSenderId: "456949595332",
  appId: "1:456949595332:web:79b40c4acc6499710f5d91"
};

firebase.initializeApp(firebaseConfig);
const database = firebase.database();

const EXAM_MINUTES = 30;
const EXAM_TOTAL_MARKS = 100;
const PASSING_SCORE = 50;
const LOCKOUT_MS = 30 * 60 * 1000;
const LOCK_KEY = "skilltester_lockout";
const DEFAULT_ADMIN_PASSWORD = "03262116352#";
let adminSession = false;

function openAdminPanel() {
  $("adminModal").classList.add("open");
  $("adminCodeInput").focus();
}

const SESSION_KEY = "skilltester_session";
const normalEmojis = ["👍", "❤️", "🔥", "🎉", "💡"];

const state = {
  candidate: null,
  questions: [],
  questionIndex: 0,
  score: 0,
  secondsLeft: EXAM_MINUTES * 60,
  timerId: null,
  examActive: false,
  answerLocked: false,
  selectedEmoji: "",
  antiCheatBound: false,
  finishing: false
};
let audioContext = null;

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.add("active");
const hide = (id) => $(id).classList.remove("active");

function playSound(kind) {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const tones = { loading: [420, 0.08], correct: [720, 0.12], wrong: [180, 0.16], success: [880, 0.18], failure: [120, 0.2] };
    const [frequency, duration] = tones[kind] || tones.loading;
    oscillator.type = kind === "wrong" || kind === "failure" ? "sawtooth" : "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.045, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + duration + 0.02);
  } catch (error) { /* Sound is progressive enhancement; exam flow remains usable. */ }
}

function toast(message, tone = "info") {
  const node = $("toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.remove("hidden");
  window.clearTimeout(toast.timeout);
  toast.timeout = window.setTimeout(() => node.classList.add("hidden"), 4500);
}

function getLockout() {
  const lockedUntil = Number(localStorage.getItem(LOCK_KEY) || 0);
  if (lockedUntil > Date.now()) return lockedUntil;
  localStorage.removeItem(LOCK_KEY);
  return 0;
}

function setLockout(reason) {
  const lockedUntil = Date.now() + LOCKOUT_MS;
  localStorage.setItem(LOCK_KEY, String(lockedUntil));
  database.ref(`examLockouts/${state.candidate?.phone || "anonymous"}`).set({ lockedUntil, reason, createdAt: firebase.database.ServerValue.TIMESTAMP }).catch(() => undefined);
}

function formatTime(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function calculateMarks(correctAnswers) {
  return Math.round((correctAnswers / state.questions.length) * EXAM_TOTAL_MARKS);
}

function isMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function bindSecurityDefaults() {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("selectstart", (event) => {
    if (!event.target.matches("input, textarea")) event.preventDefault();
  });
  document.addEventListener("dragstart", (event) => event.preventDefault());
  document.addEventListener("keydown", (event) => {
    const blocked = event.key === "F12" || event.key === "Escape" || event.key === "Tab" ||
      (event.ctrlKey && ["c", "v", "u", "s", "p"].includes(event.key.toLowerCase())) ||
      (event.metaKey && ["c", "v", "u", "s", "p"].includes(event.key.toLowerCase()));
    if (blocked && state.examActive) {
      event.preventDefault();
      if (event.key === "Escape") terminateExam("Fullscreen was exited.");
    }
  });
}

function bindAntiCheat() {
  if (state.antiCheatBound) return;
  state.antiCheatBound = true;
  document.addEventListener("visibilitychange", () => {
    if (state.examActive && document.hidden) terminateExam("Browser tab or window focus changed.");
  });
  window.addEventListener("blur", () => {
    if (state.examActive) terminateExam("Browser window lost focus.");
  });
  window.addEventListener("pagehide", () => {
    if (state.examActive) terminateExam("The exam page was hidden or closed.");
  });
  document.addEventListener("fullscreenchange", () => {
    if (state.examActive && !document.fullscreenElement && !isMobileDevice()) terminateExam("Fullscreen mode was exited.");
  });
  if (isMobileDevice()) {
    document.addEventListener("touchmove", (event) => {
      if (state.examActive) event.preventDefault();
    }, { passive: false });
  }
}

async function requestExamFullscreen() {
  if (!isMobileDevice() && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen(); }
    catch (error) { throw new Error("Fullscreen permission is required before the exam can start."); }
  }
}

function buildQuestionBank() {
  const html = [
    ["Sab se bari heading ke liye kaunsa element hota hai?", ["<h6>", "<heading>", "<h1>", "<head>"], 2],
    ["Image ke alternative text ke liye kaunsa attribute hota hai?", ["title", "alt", "src", "label"], 1],
    ["Hyperlink banane ke liye kaunsa element hota hai?", ["<link>", "<a>", "<href>", "<url>"], 1],
    ["Site navigation ke liye semantic element kaunsa hai?", ["<navigate>", "<menu>", "<nav>", "<links>"], 2],
    ["Email address ke liye behtareen input type kaunsa hai?", ["mail", "email", "text-email", "address"], 1],
    ["Video embed karne ke liye kaunsa element hota hai?", ["<media>", "<movie>", "<video>", "<play>"], 2],
    ["<!DOCTYPE html> kya declare karta hai?", ["CSS file", "HTML version aur mode", "JavaScript function", "Browser plugin"], 1],
    ["Table ki row ko represent karne wala element kaunsa hai?", ["<td>", "<th>", "<tr>", "<row>"], 2],
    ["Metadata kis tag ke andar hota hai?", ["<body>", "<meta>", "<head>", "<data>"], 2],
    ["Form control ko lazmi banane ke liye kaunsa attribute hota hai?", ["needed", "validate", "required", "must"], 2],
    ["Ordered list ke liye kaunsa element hota hai?", ["<ul>", "<ol>", "<list>", "<li>"], 1],
    ["Self-contained article ke liye kaunsa element hota hai?", ["<section>", "<article>", "<aside>", "<content>"], 1],
    ["Line break lagane ke liye kaunsa tag hota hai?", ["<break>", "<lb>", "<br>", "<newline>"], 2],
    ["Element ki unique ID set karne ke liye kaunsa attribute hota hai?", ["class", "id", "name", "key"], 1],
    ["Figure ke caption ke liye kaunsa element hota hai?", ["<caption>", "<figcaption>", "<figuretext>", "<legend>"], 1],
    ["Document ya section ka footer define karne wala tag kaunsa hai?", ["<bottom>", "<footer>", "<end>", "<section-footer>"], 1],
    ["Short inline quotation ke liye kaunsa element hota hai?", ["<quote>", "<q>", "<cite>", "<blockquote>"], 1],
    ["Link ko naye browsing context mein kholne ke liye kya use hota hai?", ["new", "target=\"_blank\"", "window=\"new\"", "open"], 1],
    ["Form control ke saath label connect karne wala element kaunsa hai?", ["<label>", "<formlabel>", "<caption>", "<field>"], 0],
    ["JavaScript ke saath graphics draw karne wala element kaunsa hai?", ["<draw>", "<canvas>", "<svg-js>", "<paint>"], 1]
  ].map(([question, options, answer]) => ({ subject: "HTML", question, options, answer }));
  const css = [
    ["Text ka color change karne wali property kaunsi hai?", ["font-color", "color", "text-color", "foreground"], 1],
    ["Flex formatting context banane wala display mode kaunsa hai?", ["display: flex", "position: flex", "layout: flex", "flex: display"], 0],
    ["Root font size ke relative kaunsi unit hoti hai?", ["em", "rem", "%", "vh"], 1],
    ["Element ke andar spacing control karne wali property kaunsi hai?", ["margin", "padding", "gap", "inset"], 1],
    ["Corners ko round karne wali property kaunsi hai?", ["corner-radius", "border-radius", "round", "radius"], 1],
    ["card naam ki class ko target karne wala selector kaunsa hai?", ["#card", ".card", "card", "*card"], 1],
    ["Stacking order change karne wali property kaunsi hai?", ["layer", "stack", "z-index", "order-index"], 2],
    ["Space rakhtay hue element ko invisible karne wali property kaunsi hai?", ["display: none", "visibility: hidden", "opacity: 0 and remove", "hidden: true"], 1],
    ["Reusable custom property value ke liye kaunsa CSS function hota hai?", ["var()", "custom()", "value()", "prop()"], 0],
    ["Grid columns control karne wali property kaunsi hai?", ["grid-template-columns", "grid-columns", "columns-grid", "template-columns"], 0],
    ["box-sizing: border-box kya karta hai?", ["Borders do baar add karta hai", "Padding aur border ko declared size mein include karta hai", "Box shadow remove karta hai", "Square force karta hai"], 1],
    ["Pointer element par hone par style karne wali pseudo-class kaunsi hai?", ["::pointer", ":hover", ":over", "@hover"], 1],
    ["Image ko background banane wali property kaunsi hai?", ["image-background", "background-image", "src-background", "background-src"], 1],
    ["Position ko viewport ke relative banane wali value kaunsi hai?", ["relative", "fixed", "absolute", "sticky"], 1],
    ["Line spacing set karne wali property kaunsi hai?", ["line-height", "text-spacing", "leading", "line-spacing"], 0],
    ["Responsive conditions define karne wali at-rule kaunsi hai?", ["@responsive", "@media", "@screen", "@breakpoint"], 1],
    ["Flex items ki direction control karne wali property kaunsi hai?", ["flex-flow-direction", "flex-direction", "direction-flex", "item-direction"], 1],
    ["Overflow content hide karne wali value kaunsi hai?", ["overflow: hidden", "clip: all", "content: hide", "hide-overflow: true"], 0],
    ["Transparency control karne wali property kaunsi hai?", ["alpha", "opacity", "transparency", "visible"], 1],
    ["Har element ko target karne wala selector kaunsa hai?", ["all", "#", ".", "*"], 3]
  ].map(([question, options, answer]) => ({ subject: "CSS", question, options, answer }));
  const javascript = [
    ["Block-scoped variable declare karne wala keyword kaunsa hai?", ["var", "let", "define", "value"], 1],
    ["JSON text ko object mein convert karne wala method kaunsa hai?", ["JSON.parse", "JSON.stringify", "JSON.object", "parse.JSON"], 0],
    ["Value aur type dono check karne wala operator kaunsa hai?", ["==", "=", "===", "equals"], 2],
    ["Array ke end mein item add karne wala method kaunsa hai?", ["push", "append", "addEnd", "insert"], 0],
    ["DOM ka full form kya hai?", ["Document Object Model", "Data Object Map", "Display Order Method", "Document Oriented Markup"], 0],
    ["Button activate hone par kaunsa event fire hota hai?", ["press", "activate", "click", "tap-only"], 2],
    ["Function define karne wala keyword kaunsa hai?", ["method", "function", "def", "procedure"], 1],
    ["Intentional empty value ko represent karne wali value kaunsi hai?", ["undefined", "null", "empty", "void-value"], 1],
    ["Pehla matching element select karne wala method kaunsa hai?", ["querySelector", "getFirst", "selectOne", "findElement"], 0],
    ["Template literal banane ke liye kaunsi syntax use hoti hai?", ["Single quotes", "Double quotes", "Backticks", "Parentheses"], 2],
    ["Promise rejection handle karne wala method kaunsa hai?", [".catch", ".error", ".reject", ".fail"], 0],
    ["Iterable values par direct loop karne wala loop kaunsa hai?", ["for...in", "for...of", "forEach-only", "repeat"], 1],
    ["Loop se bahar nikalne wala keyword kaunsa hai?", ["stop", "exit", "break", "return-loop"], 2],
    ["Browser mein origin ke liye data store karne wali API kaunsi hai?", ["window.store", "localStorage", "browserDB", "sessionFile"], 1],
    ["Closure kya hota hai?", ["CSS rule", "Aisa function jo apne lexical scope ko retain kare", "Closed tab", "Private HTML tag"], 1],
    ["Transformed values se naya array banane wala method kaunsa hai?", ["filter", "reduce", "map", "transformArray"], 2],
    ["Current object context ko refer karne wala keyword kaunsa hai?", ["self", "this", "current", "object"], 1],
    ["Delay ke baad callback schedule karne wali API kaunsi hai?", ["setTimeout", "delayCall", "waitFor", "later"], 0],
    ["typeof null ka result kis type ka hota hai?", ["null", "object", "undefined", "empty"], 1],
    ["Exceptions handle karne wali statement kaunsi hai?", ["try...catch", "handle...error", "safe...catch", "test...except"], 0]
  ].map(([question, options, answer]) => ({ subject: "JavaScript", question, options, answer }));
  return [...html, ...css, ...javascript];
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function openRegistration() {
  $("registrationModal").classList.add("open");
  $("fullName").focus();
}
function closeRegistration() { $("registrationModal").classList.remove("open"); }

function openAdminPanel() {
  $("adminModal").classList.add("open");
  $("adminCodeInput").focus();
}

function closeAdminPanel() {
  $("adminModal").classList.remove("open");
  $("adminDashboard").classList.add("hidden");
  $("adminLoginForm").classList.remove("hidden");
  $("adminCodeInput").value = "";
  adminSession = false;
}

async function verifyAdminAccess(event) {
  event.preventDefault();
  const error = $("adminError");
  error.textContent = "";
  const code = $("adminCodeInput").value.trim();
  if (!code) { error.textContent = "Admin password is required."; return; }
  try {
    const snapshot = await database.ref("adminCode").once("value");
    const admin = snapshot.val() || {};
    const configuredPassword = String(admin.password || DEFAULT_ADMIN_PASSWORD);
    if (code !== configuredPassword) throw new Error("Admin password is incorrect.");
    if (!admin.password) database.ref("adminCode/password").set(configuredPassword).catch(() => undefined);
    adminSession = true;
    $("adminLoginForm").classList.add("hidden");
    $("adminDashboard").classList.remove("hidden");
    await refreshAdminDashboard();
  } catch (errorValue) { error.textContent = errorValue.message || "Admin access could not be verified."; }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[character]));
}

async function refreshAdminDashboard() {
  if (!adminSession) return;
  const refreshButton = $("refreshAdmin");
  refreshButton.classList.add("is-loading");
  refreshButton.disabled = true;
  refreshButton.textContent = "Refreshing...";
  try {
  const [adminSnapshot, codeSnapshot, feedbackSnapshot, resultSnapshot] = await Promise.all([
    database.ref("adminCode").once("value"),
    database.ref("passcodes").once("value"),
    database.ref("examFeedback").limitToLast(20).once("value"),
    database.ref("examResults").limitToLast(20).once("value")
  ]);
  const admin = adminSnapshot.val() || {};
  const codes = codeSnapshot.val() || {};
  const feedback = feedbackSnapshot.val() || {};
  const results = resultSnapshot.val() || {};
  const codeEntries = Object.entries(codes);
  const unused = codeEntries.filter(([, value]) => value?.isUsed !== true).length;
  $("adminStatus").textContent = admin.isEnabled === true ? "Enabled" : "Disabled";
  $("adminStatus").classList.toggle("timer-warning", admin.isEnabled !== true);
  $("unusedCodes").textContent = `${unused} / 10`;
  $("passcodeList").innerHTML = codeEntries.map(([code, value]) => `<div class="admin-row"><span><strong>${escapeHtml(code)}</strong> ${escapeHtml(value?.label || "Candidate")}</span><span class="${value?.isUsed ? "used" : "available"}">${value?.isUsed ? "Used" : "Available"}</span></div>`).join("") || "<p class='modal-copy'>No candidate codes found.</p>";
  const feedbackEntries = Object.values(feedback).reverse();
  const resultEntries = Object.entries(results).reverse();
  $("resultList").innerHTML = resultEntries.map(([key, item]) => `<div class="admin-row"><span><strong>${escapeHtml(item.candidate?.fullName || "Candidate")}</strong><br>${escapeHtml(item.status || "UNKNOWN")} · ${escapeHtml(item.marks ?? "-")}/${EXAM_TOTAL_MARKS}</span><button class="admin-delete" type="button" data-result-key="${escapeHtml(key)}">Delete</button></div>`).join("") || "<p class='modal-copy'>No exam results yet.</p>";
  document.querySelectorAll("[data-result-key]").forEach((button) => button.addEventListener("click", () => deleteExamResult(button.dataset.resultKey)));
  $("feedbackList").innerHTML = feedbackEntries.map((item) => `<div class="admin-row"><span><strong>${escapeHtml(item.emoji || "")} ${escapeHtml(item.candidate?.fullName || "Candidate")}</strong><br>${escapeHtml(item.message || "No message")}</span><span>${escapeHtml(item.score ?? "-")}/100</span></div>`).join("") || "<p class='modal-copy'>No passed-candidate feedback yet.</p>";
  $("toggleAdmin").textContent = admin.isEnabled === true ? "Disable Admin Access" : "Enable Admin Access";
  $("toggleAdmin").dataset.enabled = admin.isEnabled === true ? "true" : "false";
  } finally {
    refreshButton.classList.remove("is-loading");
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh Live Data";
  }
}

async function deleteExamResult(resultKey) {
  if (!adminSession || !resultKey || !window.confirm("Is exam result ko permanently delete karna hai?")) return;
  const button = document.querySelector(`[data-result-key="${CSS.escape(resultKey)}"]`);
  if (button) { button.disabled = true; button.textContent = "Deleting..."; button.classList.add("is-loading"); }
  try {
    await database.ref(`examResults/${resultKey}`).remove();
    await refreshAdminDashboard();
    toast("Exam result deleted live from Firebase.");
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = "Delete"; button.classList.remove("is-loading"); }
    toast("Result delete nahi ho saka.", "danger");
  }
}

async function toggleAdminAccess() {
  if (!adminSession) return;
  const enabled = $("toggleAdmin").dataset.enabled !== "true";
  const toggleButton = $("toggleAdmin");
  toggleButton.classList.add("is-loading");
  toggleButton.disabled = true;
  toggleButton.textContent = "Saving...";
  try {
    await database.ref("adminCode/isEnabled").set(enabled);
    await refreshAdminDashboard();
    toast(`Admin access ${enabled ? "enabled" : "disabled"}.`);
  } finally {
    toggleButton.classList.remove("is-loading");
    toggleButton.disabled = false;
  }
}

function createOneTimeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function generatePasscode() {
  if (!adminSession) return;
  const button = $("generatePasscode");
  button.disabled = true;
  button.textContent = "Generating...";
  try {
    let generatedCode = "";
    for (let attempt = 0; attempt < 10 && !generatedCode; attempt += 1) {
      const candidateCode = createOneTimeCode();
      const result = await database.ref(`passcodes/${candidateCode}`).transaction((current) => current || {
        label: "Generated One-Time",
        isUsed: false,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });
      if (result.committed && result.snapshot.val()?.isUsed === false) generatedCode = candidateCode;
    }
    if (!generatedCode) throw new Error("Unique passcode generate nahi ho saka.");
    await refreshAdminDashboard();
    toast(`New one-time passcode: ${generatedCode}`, "success");
  } catch (error) {
    toast(error.message || "Passcode generate nahi ho saka.", "danger");
  } finally {
    button.disabled = false;
    button.textContent = "Generate One-Time Passcode";
  }
}

async function verifyPasscode(code) {
  const adminSnapshot = await database.ref("adminCode").once("value");
  const admin = adminSnapshot.val() || {};

  if (admin.isEnabled !== true) {
    throw new Error("Exam access is temporarily disabled by the administrator.");
  }

  if (String(admin.code || admin.value || "").padStart(6, "0") === code) {
    return { type: "regular" };
  }

  const lockedUntil = getLockout();
  if (lockedUntil) throw new Error(`This device is locked for ${formatTime(Math.ceil((lockedUntil - Date.now()) / 1000))}. Admin access can bypass this lock.`);
  const passcodeRef = database.ref(`passcodes/${code}`);
  const snapshot = await passcodeRef.once("value");
  const passcode = snapshot.val();
  if (!passcode || passcode.isUsed === true) throw new Error("This passcode is invalid or has already been used.");
  const result = await passcodeRef.transaction((current) => {
    if (!current || current.isUsed === true) return;
    return { ...current, isUsed: true, usedAt: firebase.database.ServerValue.TIMESTAMP };
  });
  if (!result.committed || !result.snapshot.val()?.isUsed) throw new Error("This passcode was claimed by another candidate.");
  return { type: "regular" };
}

async function submitRegistration(event) {
  event.preventDefault();
  const fullName = $("fullName").value.trim();
  const fatherName = $("fatherName").value.trim();
  const phone = $("candidatePhone").value.trim();
  const code = $("accessCode").value.trim();
  const error = $("registrationError");
  error.textContent = "";
  if (!/^[A-Za-z ]{2,30}$/.test(fullName) || !/^[A-Za-z ]{2,30}$/.test(fatherName)) { error.textContent = "Student aur father name mein sirf letters/spaces hon, maximum 30 characters."; return; }
  if (!/^03\d{9}$/.test(phone)) { error.textContent = "Mobile number exactly 11 digits ho aur 03 se start ho."; return; }
  if (!/^\d{6}$/.test(code)) { error.textContent = "Access passcode must contain exactly 6 digits."; return; }
  $("registrationSubmit").disabled = true;
  try {
    state.candidate = { fullName, fatherName, phone };
    await verifyPasscode(code);
    closeRegistration();
    await runLoadingSequence();
    startExam();
  } catch (verificationError) {
    $("loaderScreen").classList.remove("open");
    error.textContent = verificationError.message || "Passcode verification failed.";
  } finally { $("registrationSubmit").disabled = false; }
}

function runLoadingSequence() {
  playSound("loading");
  $("loaderTitle").textContent = "Verifying Passcode...";
  $("loaderText").textContent = "Checking secure access status";
  $("loaderProgress").style.width = "20%";
  $("loaderScreen").classList.add("open");
  return new Promise((resolve) => {
    window.setTimeout(() => {
      $("loaderTitle").textContent = "Initializing Anti-Cheating Environment...";
      $("loaderText").textContent = "Locking exam session and preparing question bank";
      $("loaderProgress").style.width = "100%";
      document.querySelectorAll(".loader-step")[0]?.classList.remove("active");
      document.querySelectorAll(".loader-step")[1]?.classList.add("active");
    }, 1000);
    window.setTimeout(() => {
      document.querySelectorAll(".loader-step")[1]?.classList.remove("active");
      document.querySelectorAll(".loader-step")[2]?.classList.add("active");
      $("loaderScreen").classList.remove("open");
      resolve();
    }, 4000);
  });
}

async function startExam() {
  const questionBank = buildQuestionBank();
  const subjectOrder = ["HTML", "CSS", "JavaScript"].sort(() => Math.random() - 0.5);
  state.questions = subjectOrder.flatMap((subject) => questionBank.filter((question) => question.subject === subject));
  state.questionIndex = 0; state.score = 0; state.secondsLeft = EXAM_MINUTES * 60; state.examActive = false; state.finishing = false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ candidate: state.candidate, startedAt: Date.now() }));
  await requestExamFullscreen();
  state.examActive = true;
  show("examView"); hide("homeView"); hide("resultView"); hide("failureView");
  bindAntiCheat();
  renderQuestion();
  state.timerId = window.setInterval(() => {
    state.secondsLeft -= 1;
    $("timer").textContent = formatTime(state.secondsLeft);
    if (state.secondsLeft <= 60) $("timer").classList.add("timer-warning");
    if (state.secondsLeft <= 0) finishExam("Time expired.");
  }, 1000);
}

function renderQuestion() {
  const current = state.questions[state.questionIndex];
  $("subjectBadge").textContent = current.subject;
  $("questionNumber").textContent = `Question ${state.questionIndex + 1} of ${state.questions.length}`;
  $("questionTitle").textContent = current.question;
  $("score").textContent = `${calculateMarks(state.score)} / ${EXAM_TOTAL_MARKS}`;
  $("timer").textContent = formatTime(state.secondsLeft);
  $("questionProgress").style.width = `${(state.questionIndex / state.questions.length) * 100}%`;
  const options = $("options"); options.innerHTML = ""; state.answerLocked = false;
  current.options.forEach((optionText, optionIndex) => {
    const button = document.createElement("button");
    button.className = "option"; button.type = "button"; button.textContent = `${String.fromCharCode(65 + optionIndex)}. ${optionText}`;
    button.addEventListener("click", () => answerQuestion(optionIndex, button)); options.appendChild(button);
  });
}

function answerQuestion(selectedIndex, selectedButton) {
  if (state.answerLocked || !state.examActive) return;
  state.answerLocked = true;
  const current = state.questions[state.questionIndex];
  const optionButtons = [...$("options").querySelectorAll("button")];
  optionButtons.forEach((button) => { button.disabled = true; });
  if (selectedIndex === current.answer) { state.score += 1; selectedButton.classList.add("correct"); playSound("correct"); }
  else { selectedButton.classList.add("wrong"); optionButtons[current.answer].classList.add("correct"); playSound("wrong"); }
  $("score").textContent = `${calculateMarks(state.score)} / ${EXAM_TOTAL_MARKS}`;
  window.setTimeout(() => {
    state.questionIndex += 1;
    if (state.questionIndex >= state.questions.length) finishExam("Exam completed.");
    else renderQuestion();
  }, 650);
}

function terminateExam(reason) { if (state.examActive) finishExam(reason, true); }

function finishExam(reason, cheating = false) {
  if (state.finishing) return;
  state.finishing = true; state.examActive = false;
  window.clearInterval(state.timerId); sessionStorage.removeItem(SESSION_KEY);
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => undefined);
  const finalMarks = calculateMarks(state.score);
  if (cheating || finalMarks < PASSING_SCORE) {
    setLockout(reason); saveExamResult(finalMarks, cheating ? "TERMINATED" : "FAILED", reason); playSound("failure"); renderFailure(reason, cheating);
  } else { saveExamResult(finalMarks, "PASSED", reason); playSound("success"); renderResult(); }
}

function saveExamResult(finalMarks, status, reason) {
  database.ref("examResults").push({
    candidate: state.candidate,
    marks: finalMarks,
    totalMarks: EXAM_TOTAL_MARKS,
    percentage: finalMarks,
    status,
    reason,
    questionCount: state.questions.length,
    createdAt: firebase.database.ServerValue.TIMESTAMP
  }).catch(() => undefined);
}

function renderFailure(reason, cheating) {
  hide("examView"); hide("homeView"); hide("failureView"); show("resultView");
  $("scorecard").classList.remove("hidden");
  const finalMarks = calculateMarks(state.score);
  const percentage = finalMarks;
  $("scorecard").classList.add("result-failed");
  $("resultIcon").textContent = "!";
  $("resultEyebrow").textContent = cheating ? "Security termination" : "Assessment complete";
  $("resultHeading").textContent = cheating ? "Cheating detected: exam terminated." : "Exam failed: pass mark not reached.";
  $("resultSubtitle").textContent = cheating ? `${reason} A 30-minute re-attempt lock has been applied.` : `${reason} A 30-minute re-attempt lock has been applied.`;
  $("resultName").textContent = state.candidate.fullName;
  $("resultFather").textContent = state.candidate.fatherName;
  $("resultScore").textContent = `${finalMarks} / ${EXAM_TOTAL_MARKS}`;
  $("resultPercentage").textContent = `${percentage}%`;
  $("resultRating").textContent = cheating ? "TERMINATED" : "FAILED";
  $("feedbackPanel").classList.add("hidden");
  loadLiveResults();
  loadLiveFeedback();
  window.setTimeout(() => $("resultView").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

function renderResult() {
  hide("examView"); hide("homeView"); hide("failureView"); show("resultView");
  $("scorecard").classList.remove("hidden");
  $("scorecard").classList.remove("result-failed");
  const finalMarks = calculateMarks(state.score);
  const percentage = finalMarks;
  $("resultName").textContent = state.candidate.fullName;
  $("resultFather").textContent = state.candidate.fatherName;
  $("resultScore").textContent = `${finalMarks} / ${EXAM_TOTAL_MARKS}`;
  $("resultPercentage").textContent = `${percentage}%`;
  $("resultRating").textContent = percentage >= 90 ? "Outstanding" : percentage >= 75 ? "Excellent" : "Qualified";
  $("resultIcon").textContent = "✓";
  $("resultEyebrow").textContent = "Assessment passed";
  $("resultHeading").textContent = "Congratulations, you passed.";
  $("resultSubtitle").textContent = "Your verified result card is ready. Download it, then share your feedback below.";
  show("feedbackPanel");
  loadLiveResults();
  loadLiveFeedback();
  window.setTimeout(() => $("resultView").scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

async function downloadScorecard() {
  const canvas = await html2canvas($("scorecard"), { backgroundColor: "#1e293b", scale: 2 });
  const image = canvas.toDataURL("image/png");
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ orientation: "portrait", unit: "px", format: [canvas.width, canvas.height] });
  pdf.addImage(image, "PNG", 0, 0, canvas.width, canvas.height);
  pdf.save(`skilltester-${state.candidate.fullName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`);
}

function selectEmoji(button) {
  document.querySelectorAll(".emoji-btn").forEach((node) => node.classList.remove("selected"));
  button.classList.add("selected"); state.selectedEmoji = button.dataset.emoji;
}
async function submitFeedback(event) {
  event.preventDefault();
  const message = $("feedbackMessage").value.trim();
  if (!message || !state.selectedEmoji) { $("feedbackStatus").textContent = "Choose an emoji and write feedback first."; return; }
  $("feedbackStatus").textContent = "Submitting...";
  try {
    await database.ref("examFeedback").push({ candidate: state.candidate, score: calculateMarks(state.score), emoji: state.selectedEmoji, message, createdAt: firebase.database.ServerValue.TIMESTAMP });
    $("feedbackStatus").textContent = "Thanks. Your feedback was recorded.";
    $("feedbackMessage").value = "";
  } catch (error) { $("feedbackStatus").textContent = "Feedback could not be submitted right now."; }
}

async function loadLiveResults() {
  const status = $("resultsStatus");
  const list = $("publicResultsList");
  status.textContent = "Live results Firebase se load ho rahe hain...";
  try {
    const snapshot = await database.ref("examResults").limitToLast(30).once("value");
    const results = Object.values(snapshot.val() || {}).reverse();
    list.innerHTML = results.map((result) => `<div class="public-result-row"><span><strong>${escapeHtml(result.candidate?.fullName || "Candidate")}</strong><small>${escapeHtml(result.status || "UNKNOWN")}</small></span><strong class="public-result-score">${escapeHtml(result.marks ?? "-")} / ${EXAM_TOTAL_MARKS}</strong></div>`).join("");
    status.textContent = results.length ? "Latest results live Firebase se update ho rahe hain." : "Abhi koi exam result available nahi hai.";
  } catch (error) {
    status.textContent = "Live results load nahi ho sake. Refresh karke dobara try karein.";
  }
}

async function loadLiveFeedback() {
  const status = $("publicFeedbackStatus");
  const list = $("publicFeedbackList");
  status.textContent = "Live feedback Firebase se load ho raha hai...";
  try {
    const snapshot = await database.ref("examFeedback").limitToLast(30).once("value");
    const feedbackEntries = Object.values(snapshot.val() || {}).reverse();
    list.innerHTML = feedbackEntries.map((item) => `<article class="public-feedback-item"><div class="public-feedback-meta"><strong>${escapeHtml(item.emoji || "💬")} ${escapeHtml(item.candidate?.fullName || "Candidate")}</strong><span>${escapeHtml(item.score ?? "-")} / ${EXAM_TOTAL_MARKS}</span></div><p>${escapeHtml(item.message || "No feedback message")}</p></article>`).join("");
    status.textContent = feedbackEntries.length ? "Recent feedback live Firebase se show ho raha hai." : "Abhi koi feedback submit nahi hua.";
  } catch (error) {
    status.textContent = "Feedback load nahi ho saka. Refresh karke dobara try karein.";
  }
}

function goHome(event) {
  event.preventDefault();
  if (state.examActive) { toast("Exam ke dauran Home par jana allowed nahi hai.", "danger"); return; }
  hide("examView"); hide("resultView"); hide("failureView"); show("homeView");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function goExam(event) {
  event.preventDefault();
  if (state.examActive) { $("examView").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  openRegistration();
}

function goResults(event) {
  event.preventDefault();
  hide("examView"); hide("homeView"); hide("failureView"); show("resultView");
  loadLiveResults();
  loadLiveFeedback();
  $("resultView").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("startButton").addEventListener("click", openRegistration);
$("closeRegistration").addEventListener("click", closeRegistration);
$("registrationForm").addEventListener("submit", submitRegistration);
$("adminButton").addEventListener("click", openAdminPanel);
$("closeAdmin").addEventListener("click", closeAdminPanel);
$("adminLoginForm").addEventListener("submit", verifyAdminAccess);
$("refreshAdmin").addEventListener("click", refreshAdminDashboard);
$("generatePasscode").addEventListener("click", generatePasscode);
$("toggleAdmin").addEventListener("click", toggleAdminAccess);
$("downloadButton").addEventListener("click", downloadScorecard);
$("refreshResults").addEventListener("click", loadLiveResults);
$("refreshFeedback").addEventListener("click", loadLiveFeedback);
$("feedbackForm").addEventListener("submit", submitFeedback);
document.querySelector('.main-nav a[href="#homeView"]').addEventListener("click", goHome);
document.querySelector('.main-nav a[href="#examView"]').addEventListener("click", goExam);
document.querySelector('.main-nav a[href="#resultView"]').addEventListener("click", goResults);
document.querySelectorAll(".emoji-btn").forEach((button) => button.addEventListener("click", () => selectEmoji(button)));
$("fullName").addEventListener("input", (event) => { event.target.value = event.target.value.replace(/[^A-Za-z ]/g, "").slice(0, 30); });
$("fatherName").addEventListener("input", (event) => { event.target.value = event.target.value.replace(/[^A-Za-z ]/g, "").slice(0, 30); });
$("candidatePhone").addEventListener("input", (event) => { event.target.value = event.target.value.replace(/\D/g, "").slice(0, 11); });
$("accessCode").addEventListener("input", (event) => { event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6); });
bindSecurityDefaults();
