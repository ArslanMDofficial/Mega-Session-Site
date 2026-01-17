import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { upload } from "./mega.js";

const router = express.Router();
const SESSION_MAP_FILE = "./session-map.json";

/* ===== SHORT SESSION ===== */
function generateShortSession() {
    const y = new Date().getFullYear();
    const r = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `ARSLAN_XMD_${y}_${r}`;
}

function saveSessionMap(id, mega) {
    let d = {};
    if (fs.existsSync(SESSION_MAP_FILE)) d = JSON.parse(fs.readFileSync(SESSION_MAP_FILE));
    d[id] = { mega, created: Date.now() };
    fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(d, null, 2));
}

/* ===== HELPERS ===== */
function rm(p) {
    try { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); } catch {}
}
function getMegaFileId(url) {
    const m = url?.match(/\/file\/([^#]+#[^\/]+)/);
    return m ? m[1] : null;
}

/* ===== ROUTE ===== */
router.get("/", async (req, res) => {
    let num = (req.query.number || "").replace(/[^0-9]/g, "");
    if (!num) return res.status(400).send({ code: "Number required" });

    const phone = pn("+" + num);
    if (!phone.isValid()) return res.status(400).send({ code: "Invalid number" });
    num = phone.getNumber("e164").replace("+", "");

    const dir = "./session_" + num;
    rm(dir);

    async function start() {
        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            },
            logger: pino({ level: "fatal" }),
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (u) => {
            const { connection, lastDisconnect } = u;

            if (connection === "open") {
                try {
                    const megaUrl = await upload(dir + "/creds.json", `creds_${num}_${Date.now()}.json`);
                    const megaId = getMegaFileId(megaUrl);
                    if (!megaId) throw "MEGA_FAIL";

                    const shortId = generateShortSession();
                    saveSessionMap(shortId, megaId);

                    const jid = jidNormalizedUser(num + "@s.whatsapp.net");

                    // 1️⃣ First message: only SESSION_ID
                    await sock.sendMessage(jid, {
                        text: `${shortId}`,
                    });

                    // 2️⃣ Wait 2 seconds before sending bot details
                    await delay(2000);

                    // 2️⃣ Second message: Bot info with image
                    await sock.sendMessage(jid, {
                        image: { url: "https://files.catbox.moe/jftrh0.jpg" },
                        caption:
                            `🤖 BOT DETAILS\n\n` +
                            `• Name: ARSLAN-XMD\n` +
                            `• Version: 2026\n` +
                            `• Owner: ArslanMD Official\n` +
                            `• Use this SESSION_ID in your Arslan-XMD to start the bot.`
                    });

                    // Cleanup
                    await delay(1000);
                    rm(dir);
                    process.exit(0);
                } catch {
                    rm(dir);
                    process.exit(1);
                }
            }

            if (connection === "close") {
                const c = lastDisconnect?.error?.output?.statusCode;
                if (c !== 401) start();
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                if (!res.headersSent) res.send({ code });
            } catch {
                if (!res.headersSent) res.status(503).send({ code: "PAIR_FAIL" });
                process.exit(1);
            }
        }
    }

    start();
});

/* ===== SAFETY ===== */
process.on("uncaughtException", (err) => {
    const e = String(err);
    if (e.includes("conflict") || e.includes("not-authorized") || e.includes("Timed Out")) return;
    console.error("Crash:", err);
    process.exit(1);
});

export default router;
