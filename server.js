const express = require("express");
const Stripe = require("stripe");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/3cI6oG3GC3L73lY1LB5c400";

if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.SESSION_SECRET) {
  console.warn("Missing STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET or SESSION_SECRET environment variable.");
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_missing");

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, {recursive:true});
const dbFile = path.join(dataDir, "users.json");
let users = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : [];

function save(){ fs.writeFileSync(dbFile, JSON.stringify(users, null, 2)); }
function normalizeEmail(e){ return String(e || "").trim().toLowerCase(); }
function findUser(email){ return users.find(u => u.email === normalizeEmail(email)); }
function setSession(res, user){
  const token = jwt.sign({id:user.id}, process.env.SESSION_SECRET, {expiresIn:"7d"});
  res.cookie("fitforge_session", token, {httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",maxAge:7*24*60*60*1000});
}
function currentUser(req){
  try {
    const token = req.cookies?.fitforge_session;
    if(!token) return null;
    const payload = jwt.verify(token, process.env.SESSION_SECRET);
    return users.find(u => u.id === payload.id) || null;
  } catch { return null; }
}
function requireLogin(req,res,next){
  const u=currentUser(req); if(!u) return res.redirect("/login"); req.user=u; next();
}
function requireActive(req,res,next){
  const u=currentUser(req); if(!u) return res.redirect("/login");
  if(u.subscriptionStatus !== "active" && u.subscriptionStatus !== "trialing") return res.redirect("/account?needsPayment=1");
  req.user=u; next();
}

// Stripe webhook MUST use raw body before express.json().
app.post("/stripe/webhook", express.raw({type:"application/json"}), async (req,res)=>{
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if(event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = normalizeEmail(session.customer_details?.email || session.customer_email);
      const user = findUser(email);
      if(user){
        user.subscriptionStatus = "active";
        user.stripeCustomerId = session.customer || user.stripeCustomerId;
        user.stripeSubscriptionId = session.subscription || user.stripeSubscriptionId;
        save();
      }
    }

    if(event.type === "customer.subscription.updated" || event.type === "customer.subscription.created" || event.type === "customer.subscription.deleted"){
      const sub = event.data.object;
      let user = users.find(u => u.stripeCustomerId === sub.customer);
      if(!user && sub.customer){
        try {
          const customer = await stripe.customers.retrieve(sub.customer);
          if(!customer.deleted) user = findUser(customer.email);
        } catch {}
      }
      if(user){
        user.stripeCustomerId = sub.customer;
        user.stripeSubscriptionId = sub.id;
        user.subscriptionStatus = sub.status;
        save();
      }
    }
    res.json({received:true});
  } catch(e) {
    console.error(e);
    res.status(500).send("Webhook processing failed");
  }
});

app.use(express.urlencoded({extended:false}));
app.use(express.json());
app.use(require("cookie-parser")());

app.get("/", (req,res)=>res.send(publicPage));
app.get("/signup",(req,res)=>res.send(signupPage));
app.post("/signup", async (req,res)=>{
  const email=normalizeEmail(req.body.email), password=String(req.body.password||"");
  if(!email || password.length<8) return res.status(400).send("Use a valid email and a password of at least 8 characters. <a href='/signup'>Back</a>");
  if(findUser(email)) return res.status(409).send("An account already exists for that email. <a href='/login'>Log in</a>");
  const user={id:require("crypto").randomUUID(),email,passwordHash:await bcrypt.hash(password,12),subscriptionStatus:"inactive",createdAt:new Date().toISOString()};
  users.push(user); save(); setSession(res,user); res.redirect("/account");
});
app.get("/login",(req,res)=>res.send(loginPage));
app.post("/login", async (req,res)=>{
  const user=findUser(req.body.email);
  if(!user || !(await bcrypt.compare(String(req.body.password||""),user.passwordHash))) return res.status(401).send("Incorrect email or password. <a href='/login'>Try again</a>");
  setSession(res,user); res.redirect("/account");
});
app.get("/logout",(req,res)=>{res.clearCookie("fitforge_session");res.redirect("/");});

app.get("/account", requireLogin, (req,res)=>{
  const paid=req.user.subscriptionStatus==="active"||req.user.subscriptionStatus==="trialing";
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>FitForge Account</title>
  <style>body{font-family:system-ui;background:#0b0d12;color:#fff;padding:24px}.box{max-width:600px;margin:40px auto;background:#151922;border:1px solid #252b38;border-radius:20px;padding:28px}a,button{display:inline-block;padding:14px 18px;border-radius:12px;background:#7c5cff;color:#fff;text-decoration:none;font-weight:800;margin:7px 5px 0 0}.secondary{background:#303746}.status{padding:14px;border-radius:12px;background:#0e1118;margin:15px 0;color:#cbd1de}</style></head><body><div class="box">
  <h1>Your FitForge account</h1><p>${req.user.email}</p>
  <div class="status">Subscription: <strong>${paid ? "Active" : "Not active"}</strong></div>
  ${paid ? `<a href="/workouts">Open workout library</a>` : `<p>Subscribe for $1.99/month to unlock the workout library.</p><a href="${STRIPE_PAYMENT_LINK}">Subscribe — $1.99/month</a>`}
  <a class="secondary" href="/logout">Log out</a></div></body></html>`);
});

app.get("/subscribe", requireLogin, (req,res)=>res.redirect(STRIPE_PAYMENT_LINK));

app.get("/workouts", requireActive, (req,res)=>res.send(workoutsPage));

const publicPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FitForge — Workout Generator</title>
<style>
:root{--bg:#0b0d12;--card:#151922;--muted:#a8afbf;--text:#f7f8fb;--accent:#7c5cff;--accent2:#9b85ff;--border:#252b38}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:linear-gradient(180deg,#0b0d12,#10131b);color:var(--text);min-height:100vh}
.wrap{max-width:900px;margin:auto;padding:28px 18px 60px}.hero{text-align:center;padding:34px 0 22px}.logo{font-weight:900;font-size:18px;letter-spacing:.4px;color:var(--accent2)}h1{font-size:clamp(36px,8vw,64px);line-height:1;margin:12px 0}p{color:var(--muted);line-height:1.55}.hero p{max-width:620px;margin:0 auto}.card{background:rgba(21,25,34,.96);border:1px solid var(--border);border-radius:20px;padding:22px;margin-top:20px;box-shadow:0 16px 50px rgba(0,0,0,.22)}
button,.btn{border:0;border-radius:13px;padding:14px 18px;font-weight:800;font-size:15px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.primary{background:var(--accent);color:white;width:100%;margin-top:18px}.join{background:white;color:#111;width:100%;margin-top:12px}.small{font-size:12px;color:var(--muted)}.account{text-align:center}.account a{color:#fff}
</style></head>
<body><div class="wrap">
<section class="hero"><div class="logo">FITFORGE</div>
<h1>Your workout.<br>Built in seconds.</h1>
<p>Personalised workouts, workout plans and a growing library — all in one place.</p></section>
<section class="card account">
<h2>FitForge Membership</h2>
<p>Create your free account first, then subscribe for <strong>$1.99/month</strong> to unlock the member workout library.</p>
<a class="btn primary" href="/signup">Create an account</a>
<a class="btn join" href="/login">Log in</a>
<p class="small">Already subscribed? Log in with the same email you used at checkout.</p>
</section>
<footer class="small" style="text-align:center;margin-top:28px">FitForge is for general fitness information and is not medical advice.</footer>
</div></body></html>`;
const signupPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FitForge — Create Account</title><style>
body{margin:0;background:#0b0d12;color:#f7f8fb;font-family:system-ui;padding:24px}.box{max-width:460px;margin:50px auto;background:#151922;border:1px solid #252b38;border-radius:20px;padding:26px}input{width:100%;padding:14px;margin:7px 0 15px;box-sizing:border-box;border-radius:12px;border:1px solid #303746;background:#0e1118;color:white}button{width:100%;padding:15px;border:0;border-radius:12px;background:#7c5cff;color:white;font-weight:800;font-size:16px}a{color:#b9adff}.msg{margin:12px 0;color:#ffb4b4}.note{color:#a8afbf;line-height:1.5;font-size:14px}</style></head>
<body><div class="box"><h1>Create your FitForge account</h1><p class="note">Use the same email when you pay through Stripe. That lets FitForge connect your subscription to your account.</p>
<form method="post" action="/signup"><label>Email</label><input type="email" name="email" required autocomplete="email"><label>Password</label><input type="password" name="password" required minlength="8" autocomplete="new-password"><button>Create account</button></form>
<p><a href="/">Back</a> · <a href="/login">Already have an account?</a></p></div></body></html>`;
const loginPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FitForge — Log In</title><style>
body{margin:0;background:#0b0d12;color:#f7f8fb;font-family:system-ui;padding:24px}.box{max-width:460px;margin:50px auto;background:#151922;border:1px solid #252b38;border-radius:20px;padding:26px}input{width:100%;padding:14px;margin:7px 0 15px;box-sizing:border-box;border-radius:12px;border:1px solid #303746;background:#0e1118;color:white}button{width:100%;padding:15px;border:0;border-radius:12px;background:#7c5cff;color:white;font-weight:800;font-size:16px}a{color:#b9adff}.note{color:#a8afbf;line-height:1.5;font-size:14px}</style></head>
<body><div class="box"><h1>Log in</h1><form method="post" action="/login"><label>Email</label><input type="email" name="email" required autocomplete="email"><label>Password</label><input type="password" name="password" required autocomplete="current-password"><button>Log in</button></form>
<p class="note">If you have already subscribed, use the email you used at Stripe checkout.</p><p><a href="/">Back</a> · <a href="/signup">Create an account</a></p></div></body></html>`;
const workoutsPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>FitForge — Member Workouts</title><style>
body{margin:0;font-family:system-ui;background:#f6f7fb;color:#111827}header{background:#fff;border-bottom:1px solid #e5e7eb;padding:16px 20px;display:flex;justify-content:space-between}main{max-width:1000px;margin:auto;padding:35px 20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:22px}.tag{font-size:12px;font-weight:800;background:#eef2f7;padding:6px 10px;border-radius:999px}.exercise{border-top:1px solid #e5e7eb;padding:16px 0}.meta{font-weight:800;margin-top:5px}@media(max-width:700px){.grid{grid-template-columns:1fr}}</style></head>
<body><header><strong>FITFORGE MEMBER WORKOUTS</strong><a href="/account">Account</a></header><main>
<h1>Workout Library</h1><p>You're in — this page is only served after the server verifies your active FitForge subscription.</p>
<div class="grid"><div class="card"><span class="tag">BEGINNER</span><h2>Full Body Starter</h2>
<div class="exercise"><strong>Bodyweight Squat</strong><div class="meta">3 × 10 · Rest 60 sec</div></div>
<div class="exercise"><strong>Push-Ups</strong><div class="meta">3 × 8–12 · Rest 60 sec</div></div>
<div class="exercise"><strong>Glute Bridge</strong><div class="meta">3 × 12 · Rest 45 sec</div></div>
<div class="exercise"><strong>Plank</strong><div class="meta">3 × 20–30 sec · Rest 45 sec</div></div></div>
<div class="card"><span class="tag">HOME</span><h2>No-Equipment Workout</h2>
<div class="exercise"><strong>Reverse Lunges</strong><div class="meta">3 × 10 each leg · Rest 60 sec</div></div>
<div class="exercise"><strong>Incline Push-Ups</strong><div class="meta">3 × 8–15 · Rest 60 sec</div></div>
<div class="exercise"><strong>Mountain Climbers</strong><div class="meta">3 × 20 · Rest 45 sec</div></div>
<div class="exercise"><strong>Dead Bug</strong><div class="meta">3 × 8 each side · Rest 45 sec</div></div></div>
<div class="card"><span class="tag">GYM</span><h2>Strength Builder</h2>
<div class="exercise"><strong>Goblet Squat</strong><div class="meta">3 × 8–10 · Rest 90 sec</div></div>
<div class="exercise"><strong>Dumbbell Row</strong><div class="meta">3 × 8–12 · Rest 90 sec</div></div>
<div class="exercise"><strong>Dumbbell Press</strong><div class="meta">3 × 8–12 · Rest 90 sec</div></div>
<div class="exercise"><strong>Romanian Deadlift</strong><div class="meta">3 × 8–10 · Rest 90 sec</div></div></div></div></main></body></html>`;

app.listen(PORT,()=>console.log(`FitForge running on ${BASE_URL}`));
