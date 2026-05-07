import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

const listed =
  process.env.FRONTEND_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const allowedOrigins = listed.length > 0 ? listed : [FRONTEND_ORIGIN];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true
  })
);
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "express-backend" });
});

const loginHandler: express.RequestHandler = (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || !password) {
    res.status(400).json({ error: "missing_email_or_password" });
    return;
  }

  if (email === "test@example.com" && password === "123456") {
    res.json({
      ok: true,
      token: "demo-token-123",
      user: { id: "u1", email: "test@example.com", name: "Test User" }
    });
    return;
  }

  res.status(401).json({ error: "invalid_credentials" });
};

app.post("/api/login", loginHandler);
app.post("/api/auth/login", loginHandler);

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
