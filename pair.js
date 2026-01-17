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

/* ===================== SESSION SHORT SYSTEM ===================== */

const SESSION_MAP_FILE = "./session-map.json";

function generateShortSession() {
    const year = new Date().getFullYear();
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `ARSLAN_XMD_${year}_${rand}`;
}

function saveSessionMap(shortId, megaFileId) {
    let data = {};
    if (fs.existsSync(SESSION_MAP_FILE)) {
        data = JSON.parse(fs.readFileSync(SESSION_MAP_FILE));
    }
    data[shortId] = {
        mega: megaFileId,
        created: Date.now(),
    };
    fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(data, null, 2));
}

/* ===================== HELPERS ===================== */

function removeFile(path) {
    try {
        if (fs.existsSync(path)) {
            fs.rmSync(path, { recursive: true, force: true });
        }
    } catch (e) {
        console.error("Remove error:", e);
    }
}

function getMegaFileId(url) {
    try {
        const match = url.match(/\/file\/([^#]+#[^\/]+)/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/* ===================== ROUTE ===================== */

router.get("/", async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).send({ code: "Number is required" });

    num = num.replace(/[^0-9]/g, "");
    const phone = pn("+" + num);

    if (!phone.isValid()) {
        return res.status(400).send({
            code: "Invalid phone number. Use international format without +",
        });
    }

    num = phone.getNumber("e164").replace("+", "");
    const sessionDir = "./session_" + num;

    removeFile(sessionDir);

    async function startPair() {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    pino({ level: "fatal" }),
                ),
            },
            logger: pino({ level: "fatal" }),
            browser: Browsers.windows("Chrome"),
            printQRInTerminal: false,
            markOnlineOnConnect: false,
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                try {
                    const credsPath = sessionDir + "/creds.json";
                    const megaUrl = await upload(
                        credsPath,
                        `creds_${num}_${Date.now()}.json`,
                    );

                    const megaFileId = getMegaFileId(megaUrl);
                    if (!megaFileId) throw "MEGA upload failed";

                    const shortSession = generateShortSession();
                    saveSessionMap(shortSession, megaFileId);

                    const jid = jidNormalizedUser(num + "@s.whatsapp.net");
                    await sock.sendMessage(jid, {
                        text:
                            `✅ SESSION GENERATED SUCCESSFULLY\n\n` +
                            `🔑 SESSION_ID:\n${shortSession}\n\n` +
                            `⚠️ Keep this ID safe`,
                    });

                    await delay(1000);
                    removeFile(sessionDir);
                    process.exit(0);
                } catch (err) {
                    console.error("Upload error:", err);
                    removeFile(sessionDir);
                    process.exit(1);
                }
            }

            if (connection === "close") {
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code !== 401) startPair();
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                if (!res.headersSent) res.send({ code });
            } catch (e) {
                if (!res.headersSent) {
                    res.status(503).send({
                        code: "Failed to get pairing code",
                    });
                }
                process.exit(1);
            }
        }
    }

    startPair();
});

/* ===================== SAFETY ===================== */

process.on("uncaughtException", (err) => {
    const e = String(err);
    if (
        e.includes("conflict") ||
        e.includes("not-authorized") ||
        e.includes("Timed Out")
    )
        return;
    console.error("Crash:", err);
    process.exit(1);
});

export default router;
