import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:5173";

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "express-backend" });
});

app.post("/api/login", (req, res) => {
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
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
