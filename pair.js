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
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

/* ===== SHORT SESSION ID GENERATOR WITH BASE64 ENCODING ===== */
async function generateShortSession(credsPath) {
    try {
        // Read the actual creds.json file
        const credsData = fs.readFileSync(credsPath, 'utf-8');
        
        // Encode the credentials to base64
        const base64Creds = Buffer.from(credsData).toString('base64');
        
        // Generate session ID with prefix
        const y = new Date().getFullYear();
        const r = Math.random().toString(36).substring(2, 6).toUpperCase();
        const sessionId = `ARSLAN-XMD~`;
        
        // Return both session ID and encoded data
        return {
            sessionId: sessionId,
            encodedData: base64Creds
        };
    } catch (error) {
        console.error("Error generating short session:", error);
        return null;
    }
}

/* ===== HELPERS ===== */
function rm(p) {
    try { 
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); 
    } catch(e) {
        console.log("Cleanup error:", e);
    }
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

        sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
            if (connection === "open") {
                try {
                    // Wait for creds to be saved
                    await delay(3000);
                    
                    // Path to creds.json
                    const credsPath = join(dir, 'creds.json');
                    
                    // Generate short session with encoded data
                    const sessionInfo = await generateShortSession(credsPath);
                    
                    if (!sessionInfo) {
                        throw new Error("Failed to generate session");
                    }

                    const jid = jidNormalizedUser(num + "@s.whatsapp.net");

                    // 1️⃣ Send the COMPLETE session string (SESSION_ID + base64 data)
                    const completeSession = `${sessionInfo.sessionId}_${sessionInfo.encodedData}`;
                    await sock.sendMessage(jid, { 
                        text: `SESSION_ID: ${completeSession}\n\nCopy this ENTIRE string to your bot's config.` 
                    });

                    // 2️⃣ Wait 2 seconds
                    await delay(2000);

                    // 3️⃣ Send bot info
                    await sock.sendMessage(jid, {
                        image: { url: "https://files.catbox.moe/jftrh0.jpg" },
                        caption:
                            `🤖 BOT DETAILS\n\n` +
                            `• Name: ARSLAN-XMD\n` +
                            `• Version: 8.0.0\n` +
                            `• Session ID: ${sessionInfo.sessionId}\n` +
                            `• Owner: ArslanMD Official\n\n` +
                            `📝 Instructions:\n` +
                            `1. Copy the session string above\n` +
                            `2. Paste in config.js as SESSION_ID\n` +
                            `3. Restart your bot\n` +
                            `4. Bot will auto-connect!`
                    });

                    // 4️⃣ Cleanup
                    await delay(2000);
                    rm(dir);
                    
                    // Exit gracefully
                    setTimeout(() => {
                        process.exit(0);
                    }, 1000);
                    
                } catch (err) {
                    console.error("❌ Error in pairing process:", err);
                    rm(dir);
                    
                    // Try to send error to user
                    try {
                        const jid = jidNormalizedUser(num + "@s.whatsapp.net");
                        await sock.sendMessage(jid, { 
                            text: "❌ Error generating session. Please try again." 
                        });
                    } catch(e) {}
                    
                    process.exit(1);
                }
            }

            if (connection === "close") {
                const c = lastDisconnect?.error?.output?.statusCode;
                if (c !== 401) {
                    setTimeout(() => start(), 2000);
                }
            }
        });

        if (!sock.authState.creds.registered) {
            await delay(3000);
            try {
                let code = await sock.requestPairingCode(num);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                if (!res.headersSent) {
                    res.send({ 
                        success: true, 
                        code: code,
                        message: "Scan QR code or use pairing code to connect" 
                    });
                }
            } catch(err) {
                console.error("Pairing error:", err);
                if (!res.headersSent) {
                    res.status(503).send({ 
                        code: "PAIR_FAIL", 
                        error: err.message 
                    });
                }
                rm(dir);
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
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection:", err);
});

export default router;
