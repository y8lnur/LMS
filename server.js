// ============================================================
// CheckIn Pro — Backend (Node.js + Express + Supabase)
// ============================================================
// npm install express cors dotenv @supabase/supabase-js resend

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

// ── Middleware: verify JWT token from Supabase Auth ──────────
async function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: "Invalid token" });
  req.user = user;
  // Fetch profile (role, name, etc.)
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  req.profile = profile;
  next();
}

// ── POST /checkin ─────────────────────────────────────────────
app.post("/checkin", auth, async (req, res) => {
  const { office } = req.body;
  if (!office) return res.status(400).json({ error: "Office required" });

  const { data, error } = await supabase.from("checkins").insert({
    user_id: req.user.id,
    office,
    checked_in_at: new Date().toISOString(),
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  // Email notification to manager
  if (req.profile?.manager_email) {
    await resend.emails.send({
      from: "checkin@yourdomain.com",
      to: req.profile.manager_email,
      subject: `✅ ${req.profile.full_name} checked in`,
      html: `<p><b>${req.profile.full_name}</b> checked in at <b>${office}</b> on ${new Date().toLocaleString()}.</p>`,
    });
  }

  res.json({ success: true, checkin: data });
});

// ── GET /checkins ─────────────────────────────────────────────
// Employee: their own. Admin/HR/Exec: all or filtered
app.get("/checkins", auth, async (req, res) => {
  const { office, team, date } = req.query;
  const role = req.profile?.role;

  let query = supabase
    .from("checkins")
    .select("*, profiles(full_name, team, office)")
    .order("checked_in_at", { ascending: false })
    .limit(200);

  // Employees only see their own checkins
  if (role === "employee") query = query.eq("user_id", req.user.id);
  // Managers see their team
  if (role === "manager") query = query.eq("profiles.team", req.profile.team);

  if (office && office !== "All") query = query.eq("office", office);
  if (date) query = query.gte("checked_in_at", date).lt("checked_in_at", date + "T23:59:59");

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── GET /stats ────────────────────────────────────────────────
app.get("/stats", auth, async (req, res) => {
  const role = req.profile?.role;
  if (role === "employee") return res.status(403).json({ error: "Forbidden" });

  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("checkins")
    .select("office, user_id, profiles(team)")
    .gte("checked_in_at", today);

  if (error) return res.status(500).json({ error: error.message });

  const uniqueEmployees = new Set(data.map(c => c.user_id)).size;
  const byOffice = data.reduce((acc, c) => { acc[c.office] = (acc[c.office] || 0) + 1; return acc; }, {});
  const byTeam = data.reduce((acc, c) => { const t = c.profiles?.team || "—"; acc[t] = (acc[t] || 0) + 1; return acc; }, {});

  res.json({ total: data.length, uniqueEmployees, byOffice, byTeam });
});

// ── GET /export ───────────────────────────────────────────────
app.get("/export", auth, async (req, res) => {
  const role = req.profile?.role;
  if (!["manager", "hr", "exec"].includes(role)) return res.status(403).json({ error: "Forbidden" });

  const { from, to } = req.query;
  let query = supabase.from("checkins").select("*, profiles(full_name, team)").order("checked_in_at", { ascending: false });
  if (from) query = query.gte("checked_in_at", from);
  if (to) query = query.lte("checked_in_at", to);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Return CSV
  const csv = [
    "Name,Team,Office,Date,Time",
    ...data.map(c => {
      const d = new Date(c.checked_in_at);
      return `"${c.profiles?.full_name}","${c.profiles?.team}","${c.office}","${d.toLocaleDateString()}","${d.toLocaleTimeString()}"`;
    })
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="checkins-export.csv"`);
  res.send(csv);
});

// ── GET /profile ──────────────────────────────────────────────
app.get("/profile", auth, async (req, res) => {
  res.json(req.profile);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
