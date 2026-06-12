 /**
 * ═══════════════════════════════════════════════════════
 *  CBT PORTAL — NODE.JS BACKEND + MONGODB ATLAS
 *  Cityside Secondary School, Sagamu, Ogun State
 *
 *  ENVIRONMENT VARIABLES (set in Render dashboard):
 *    MONGO_URI   — your MongoDB Atlas connection string
 *    PORT        — set automatically by Render (don't touch)
 *
 *  Deploy on Render:
 *    Build command : npm install
 *    Start command : node server.js
 *
 *  Local test:
 *    Create a .env file with MONGO_URI=<your string>
 *    then: npm install && node server.js
 * ═══════════════════════════════════════════════════════
 */

require('dotenv').config();          // loads .env locally; harmless on Render

const express    = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const os         = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname + '/public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════
//  MONGODB CONNECTION
// ══════════════════════════════════════════════════════

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error('❌  MONGO_URI environment variable is not set!');
  console.error('    Set it in Render → Environment, or create a .env file locally.');
  process.exit(1);
}

let db;   // MongoDB database handle — shared across all routes

async function connectDB() {
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  db = client.db('cbt_portal');   // database name inside Atlas
  console.log('✅  Connected to MongoDB Atlas');

  // ── Seed default config doc if it doesn't exist ──
  const cfg = await db.collection('config').findOne({ _id: 'main' });
  if (!cfg) {
    await db.collection('config').insertOne({
      _id:            'main',
      adminId:        'admin',
      adminPass:      'admin123',
      schoolName:     'Cityside Secondary School',
      schoolLocation: 'Sagamu, Ogun State',
    });
    console.log('🌱  Default config seeded.');
  }
}

// Helper — get config doc
async function getConfig() {
  return db.collection('config').findOne({ _id: 'main' });
}

// Helper — log activity (capped at 50 entries)
async function logActivity(msg) {
  const col = db.collection('activity');
  await col.insertOne({ msg, time: new Date().toLocaleString('en-NG'), createdAt: new Date() });
  // Keep only the latest 50 entries
  const count = await col.countDocuments();
  if (count > 50) {
    const oldest = await col.find().sort({ createdAt: 1 }).limit(count - 50).toArray();
    const ids = oldest.map(d => d._id);
    await col.deleteMany({ _id: { $in: ids } });
  }
}

// ══════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════

// Student login
app.post('/api/student/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.json({ ok: false, error: 'Username and password are required.' });

    const student = await db.collection('students').findOne({
      surname:  { $regex: new RegExp('^' + username.trim() + '$', 'i') },
      admNo:    password.trim()
    });

    if (!student)
      return res.json({ ok: false, error: 'Incorrect username or password.' });

    // Which exams has this student already sat?
    const taken = await db.collection('results')
      .find({ studentId: student._id.toString() })
      .project({ examId: 1 })
      .toArray();
    const takenExamIds = taken.map(r => r.examId);

    res.json({
  ok: true,
  student: {
    id:        student._id.toString(),
    surname:   student.surname,
    firstName: student.firstName,
    class:     student.class,
    photo:     student.photo || null
  },
  takenExamIds
});
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'Server error during login.' });
  }
});

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { adminId, adminPass } = req.body;
    const cfg = await getConfig();
    if (adminId !== cfg.adminId || adminPass !== cfg.adminPass)
      return res.json({ ok: false, error: 'Incorrect Admin ID or password.' });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Server error.' });
  }
});

// ══════════════════════════════════════════════════════
//  STUDENT ROUTES
// ══════════════════════════════════════════════════════

// Get exams for a class, with taken flag per student
app.get('/api/exams/:studentClass/:studentId', async (req, res) => {
  try {
    const cls = decodeURIComponent(req.params.studentClass);
    const sid = req.params.studentId;

    const [exams, takenDocs] = await Promise.all([
      db.collection('exams').find({ studentClass: cls }).toArray(),
      db.collection('results').find({ studentId: sid }).project({ examId: 1 }).toArray()
    ]);

    const takenIds = new Set(takenDocs.map(r => r.examId));

    const result = exams.map(e => ({
  id:            e._id.toString(),
  subject:       e.subject,
  icon:          e.icon,
  time:          e.time,
  instructions:  e.instructions,
  questionCount: e.questions.length,
  taken:         takenIds.has(e._id.toString()),
  locked:        e.examStatus !== 'open'
}));

res.json({ ok: true, exams: result });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'Could not load exams.' });
  }
});

// Get full exam questions — answers stripped, retake blocked
app.get('/api/exam/:id/:studentId', async (req, res) => {
  try {
    let examId;
    try { examId = new ObjectId(req.params.id); }
    catch { return res.json({ ok: false, error: 'Invalid exam ID.' }); }

    const [exam, alreadyTaken] = await Promise.all([
      db.collection('exams').findOne({ _id: examId }),
      db.collection('results').findOne({
        examId:    req.params.id,
        studentId: req.params.studentId
      })
    ]);

    if (!exam)         return res.json({ ok: false, error: 'Exam not found.' });
    if (alreadyTaken)  return res.json({ ok: false, error: 'You have already taken this exam.' });

    res.json({
      ok: true,
      exam: {
        id:           exam._id.toString(),
        subject:      exam.subject,
        icon:         exam.icon,
        time:         exam.time,
        instructions: exam.instructions,
        questions:    exam.questions.map(q => ({
  question: q.question,
  type:     q.type  || 'mcq',
  image:    q.image || null,
  passage:  q.passage || null,
  a: q.a, b: q.b, c: q.c, d: q.d
  // answer intentionally excluded
}))
      }
    });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'Could not load exam.' });
  }
});

// Submit exam result — server-side marking
app.post('/api/result', async (req, res) => {
  try {
    const { studentId, studentName, studentClass, examId, answers, timeout } = req.body;
    if (!studentId || !examId || !answers)
      return res.json({ ok: false, error: 'Missing submission data.' });

    // Prevent duplicate submission
    const dup = await db.collection('results').findOne({ examId, studentId });
    if (dup) return res.json({ ok: false, error: 'This exam has already been submitted.' });

    let examObjId;
    try { examObjId = new ObjectId(examId); }
    catch { return res.json({ ok: false, error: 'Invalid exam ID.' }); }

    const exam = await db.collection('exams').findOne({ _id: examObjId });
    if (!exam) return res.json({ ok: false, error: 'Exam not found.' });

    // Mark answers
    let correct = 0, wrong = 0, skipped = 0;
    exam.questions.forEach((q, i) => {
  const given = (answers[i] || '').trim();
  if (!given) {
    skipped++;
  } else if (q.type === 'fill') {
    if (given.toLowerCase() === q.answer.toLowerCase()) correct++;
    else wrong++;
  } else {
    if (given.toUpperCase() === q.answer.toUpperCase()) correct++;
    else wrong++;
  }
});
    const total = exam.questions.length;
    const pct   = total > 0 ? Math.round((correct / total) * 100) : 0;

    const resultDoc = {
      studentId, studentName,
      class:     studentClass,
      examId,
      subject:   exam.subject,
      correct, wrong, skipped, total, pct,
      date:      new Date().toLocaleString('en-NG'),
      createdAt: new Date(),
      timeout:   timeout || false
    };

    await db.collection('results').insertOne(resultDoc);
    await logActivity(`${studentName} submitted ${exam.subject} — ${pct}% (${studentClass})`);

    res.json({ ok: true, result: { correct, wrong, skipped, total, pct, subject: exam.subject } });
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'Could not save result.' });
  }
});

// School info — for login page branding
app.get('/api/school', async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json({ ok: true, schoolName: cfg.schoolName, schoolLocation: cfg.schoolLocation });
  } catch (e) {
    res.json({ ok: true, schoolName: 'CBT Portal', schoolLocation: '' });
  }
});

// ══════════════════════════════════════════════════════
//  ADMIN ROUTES
// ══════════════════════════════════════════════════════

// Overview / dashboard stats
app.get('/api/admin/overview', async (req, res) => {
  try {
    const [sc, ec, rc, activity] = await Promise.all([
      db.collection('students').countDocuments(),
      db.collection('exams').countDocuments(),
      db.collection('results').countDocuments(),
      db.collection('activity').find().sort({ createdAt: -1 }).limit(12).toArray()
    ]);

    const subjects = await db.collection('exams').distinct('subject');

    res.json({
      ok: true,
      studentCount: sc,
      examCount:    ec,
      resultCount:  rc,
      subjectCount: subjects.length,
      activity:     activity.map(a => ({ msg: a.msg, time: a.time }))
    });
  } catch (e) {
    res.json({ ok: false, error: 'Could not load overview.' });
  }
});

// ── Students ──────────────────────────────────────────

app.get('/api/admin/students', async (req, res) => {
  try {
    const students = await db.collection('students').find().sort({ class: 1, surname: 1 }).toArray();
    res.json({ ok: true, students: students.map(s => ({ ...s, id: s._id.toString() })) });
  } catch (e) {
    res.json({ ok: false, error: 'Could not load students.' });
  }
});

app.post('/api/admin/students', async (req, res) => {
  try {
    const { surname, firstName, admNo, studentClass, photo } = req.body;
    if (!surname || !firstName || !admNo || !studentClass)
      return res.json({ ok: false, error: 'All student fields are required.' });

    const exists = await db.collection('students').findOne({ admNo: admNo.trim() });
    if (exists) return res.json({ ok: false, error: 'Admission number already exists.' });

    const doc = {
  surname:   surname.trim(),
  firstName: firstName.trim(),
  admNo:     admNo.trim(),
  class:     studentClass,
  photo:     photo || null,
  createdAt: new Date()
};

    const result = await db.collection('students').insertOne(doc);
    await logActivity(`Student added: ${firstName} ${surname} (${studentClass})`);
    res.json({ ok: true, student: { ...doc, id: result.insertedId.toString() } });
  } catch (e) {
    res.json({ ok: false, error: 'Could not add student.' });
  }
});

app.delete('/api/admin/students/:id', async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const s   = await db.collection('students').findOne({ _id });
    if (!s) return res.json({ ok: false, error: 'Student not found.' });
    await db.collection('students').deleteOne({ _id });
    await logActivity(`Student deleted: ${s.firstName} ${s.surname}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Could not delete student.' });
  }
});

// ── Exams / Questions ─────────────────────────────────

app.get('/api/admin/exams', async (req, res) => {
  try {
    const exams = await db.collection('exams').find().sort({ createdAt: -1 }).toArray();
    res.json({ ok: true, exams: exams.map(e => ({ ...e, id: e._id.toString() })) });
  } catch (e) {
    res.json({ ok: false, error: 'Could not load exams.' });
  }
});

app.post('/api/admin/exams', async (req, res) => {
  try {
    const { subject, studentClass, time, icon, instructions, questions } = req.body;
    if (!subject || !studentClass || !time || !questions?.length)
      return res.json({ ok: false, error: 'Subject, class, time and questions are required.' });

    const doc = {
      subject, studentClass,
      time:         parseInt(time),
      icon:         icon || '📚',
      instructions: instructions || '',
      questions,
      createdAt:    new Date()
    };

    // Upsert — replace if same subject+class already exists
    const existing = await db.collection('exams').findOne({ subject, studentClass });
    if (existing) {
      await db.collection('exams').replaceOne({ _id: existing._id }, { ...doc, _id: existing._id });
      // Clear results for the old exam so students can retake it
      await db.collection('results').deleteMany({ examId: existing._id.toString() });
      await logActivity(`Exam updated: ${subject} for ${studentClass} (${questions.length} questions)`);
      res.json({ ok: true, exam: { id: existing._id.toString(), subject, studentClass, time: doc.time, questionCount: questions.length } });
    } else {
      const result = await db.collection('exams').insertOne(doc);
      await logActivity(`Exam created: ${subject} for ${studentClass} (${questions.length} questions)`);
      res.json({ ok: true, exam: { id: result.insertedId.toString(), subject, studentClass, time: doc.time, questionCount: questions.length } });
    }
  } catch (e) {
    console.error(e);
    res.json({ ok: false, error: 'Could not save exam.' });
  }
});
// Toggle exam open/closed
app.post('/api/admin/exams/:id/status', async (req, res) => {
  try {
    const _id        = new ObjectId(req.params.id);
    const { examStatus } = req.body;
    if (!['open','closed'].includes(examStatus))
      return res.json({ ok: false, error: 'Invalid status.' });

    await db.collection('exams').updateOne({ _id }, { $set: { examStatus } });
    await logActivity(`Exam ${examStatus === 'open' ? 'opened' : 'closed'}: ${req.params.id}`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Could not update exam status.' });
  }
});
app.delete('/api/admin/exams/:id', async (req, res) => {
  try {
    const _id = new ObjectId(req.params.id);
    const e   = await db.collection('exams').findOne({ _id });
    if (!e) return res.json({ ok: false, error: 'Exam not found.' });
    await db.collection('exams').deleteOne({ _id });
    // Remove associated results so the slot is clean
    await db.collection('results').deleteMany({ examId: req.params.id });
    await logActivity(`Exam deleted: ${e.subject} (${e.studentClass})`);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Could not delete exam.' });
  }
});

// ── Results ───────────────────────────────────────────

app.get('/api/admin/results', async (req, res) => {
  try {
    const filter = {};
    if (req.query.class)   filter.class   = req.query.class;
    if (req.query.subject) filter.subject = req.query.subject;

    const results = await db.collection('results')
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ ok: true, results: results.map(r => ({ ...r, id: r._id.toString() })) });
  } catch (e) {
    res.json({ ok: false, error: 'Could not load results.' });
  }
});

app.delete('/api/admin/results', async (req, res) => {
  try {
    await db.collection('results').deleteMany({});
    await logActivity('All results cleared by admin.');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Could not clear results.' });
  }
});

// ── Settings ──────────────────────────────────────────

app.get('/api/admin/settings', async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json({ ok: true, schoolName: cfg.schoolName, schoolLocation: cfg.schoolLocation });
  } catch (e) {
    res.json({ ok: false, error: 'Could not load settings.' });
  }
});

app.post('/api/admin/settings', async (req, res) => {
  try {
    const { schoolName, schoolLocation } = req.body;
    const update = {};
    if (schoolName)     update.schoolName     = schoolName;
    if (schoolLocation) update.schoolLocation = schoolLocation;
    await db.collection('config').updateOne({ _id: 'main' }, { $set: update });
    await logActivity('School info updated.');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Could not save settings.' });
  }
});

app.post('/api/admin/credentials', async (req, res) => {
  try {
    const { adminId, adminPass } = req.body;
    if (!adminId || !adminPass)
      return res.json({ ok: false, error: 'Both fields are required.' });
    await db.collection('config').updateOne(
      { _id: 'main' },
      { $set: { adminId, adminPass } }
    );
    await logActivity('Admin credentials updated.');
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Could not update credentials.' });
  }
});

app.delete('/api/admin/reset', async (req, res) => {
  try {
    await Promise.all([
      db.collection('students').deleteMany({}),
      db.collection('exams').deleteMany({}),
      db.collection('results').deleteMany({}),
      db.collection('activity').deleteMany({}),
      db.collection('config').updateOne(
        { _id: 'main' },
        { $set: {
          adminId:        'admin',
          adminPass:      'admin123',
          schoolName:     'Cityside Secondary School',
          schoolLocation: 'Sagamu, Ogun State'
        }}
      )
    ]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: 'Reset failed.' });
  }
});

// ══════════════════════════════════════════════════════
//  START — connect to MongoDB first, then listen
// ══════════════════════════════════════════════════════
connectDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║   CBT PORTAL SERVER — RUNNING           ║');
    console.log(`║   Port : ${PORT}                             ║`);
    console.log('║   DB   : MongoDB Atlas                  ║');
    const nets = os.networkInterfaces();
    Object.values(nets).flat().forEach(n => {
      if (n.family === 'IPv4' && !n.internal)
        console.log(`║   LAN  : http://${n.address}:${PORT}       ║`);
    });
    console.log('╚══════════════════════════════════════════╝\n');
  });
}).catch(err => {
  console.error('❌  Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
