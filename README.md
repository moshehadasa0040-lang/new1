# Content Blocker Suite

מערכת לחסימת תוכנות וידאו/מדיה במחשב מקומי, עם דשבורד ניהול מרוחק.

## מה תוקן (17.08) - באג קריטי בהתקנת השירות

**הבעיה שהתגלתה:** גרסה קודמת השתמשה בספריית `node-windows` כדי לרשום את ה-agent כשירות Windows. כש-`pkg` אורז את הקוד ל-`.exe` יחיד, `node-windows` לא הצליח לאתר את קבצי ה-Node.js האמיתיים (הם "וירטואליים" בתוך הקובץ הארוז) — וההתקנה כשירות נכשלה בשקט, גם עם הרשאות מנהל. התוצאה: הקובץ הותקן אבל שום דבר לא רץ ברקע, ולכן החסימה לא פעלה בפועל.

**הפתרון:** הוחלף `node-windows` ב-**NSSM** (Non-Sucking Service Manager) — כלי חיצוני יציב שעוטף כל `.exe` עצמאי כשירות Windows, בלי תלות ב-node.exe. ה-installer מוריד את NSSM אוטומטית בזמן ה-build (ב-GitHub Actions) ומשתמש בו לרישום/הפעלה/הסרה של השירות.

**היקף ה"הסרה מרחוק" מהדשבורד:** כרגע פקודת "הסר תוכנה" מהדשבורד עוצרת ומסירה את השירות (כך שהחסימה נפסקת) ומוחקת את זהות המכשיר המקומית — אבל לא מוחקת את קבצי ההתקנה עצמם. להסרה מלאה של הקבצים, עדיין אפשר דרך "הוספה/הסרה של תוכניות" בווינדוס. זו בחירה מכוונת כדי להימנע ממחיקת קבצים תוך כדי שהתהליך שמריץ אותם עדיין פעיל.

---

מורכבת משני חלקים:
- **`agent/`** — תוכנת רקע (Windows Service) שמותקנת על כל מחשב, חוסמת תהליכים לפי רשימה, ומדווחת לשרת.
- **`server/`** — API + דשבורד web, מיועד לדפלוי ל-[Render](https://render.com).

---

## 1. הקמת השרת (Render + Aiven)

מסד הנתונים הוא **Aiven Valkey/Redis** חיצוני (לא מסד ה-Postgres/Key Value של Render עצמו), כך שההקמה נעשית דרך **New → Web Service** רגיל, לא Blueprint:

1. צור repo חדש ב-GitHub והעלה אליו את כל התיקייה הזו (ראה פקודות בסוף).
2. ב-[Render](https://dashboard.render.com) → **New → Web Service** → חבר את ה-repo.
3. הגדרות השירות:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. בסעיף **Environment Variables**, הוסף שלושה משתנים:
   - `REDIS_URL` — ה-Service URI המלא מ-Aiven (מתחיל ב-`rediss://default:...`)
   - `ADMIN_PASSWORD` — הסיסמה שלך לכניסה לדשבורד
   - `SESSION_SECRET` — מחרוזת אקראית ארוכה (למשל `openssl rand -hex 32`)
5. Deploy web service. בלוג אמור להופיע `Connected to Redis/Valkey.` ולאחריו `Your service is live`.
6. גש לכתובת שRender נתן (למשל `https://new1-q4bb.onrender.com`) — אמור להופיע מסך התחברות לדשבורד.

> קובץ `server/render.yaml` נשאר בפרויקט כתיעוד/גיבוי להקמה עתידית אוטומטית (Blueprint), אבל אינו נדרש בשיטת ה-Web Service הידנית שבה השתמשת.

**הרצה מקומית (לבדיקות):**
```bash
cd server
cp .env.example .env   # ומלא DATABASE_URL אמיתי + ADMIN_PASSWORD
npm install
npm start
```

---

## 2. בניית ה-installer (אוטומטי דרך GitHub Actions)

`agent/src/config.js` כבר מוגדר עם כתובת השרת החי שלך:
```js
SERVER_URL: process.env.CB_SERVER_URL || 'https://new1-q4bb.onrender.com',
```
אם בעתיד תעביר את השרת לכתובת אחרת, זה המקום היחיד שצריך לעדכן.

לאחר push ל-branch `main` (או הרצה ידנית מטאב **Actions** ב-GitHub → *Build agent installer* → *Run workflow*), ה-workflow ב-`.github/workflows/build-installer.yml` יבנה אוטומטית:
1. אורז את ה-agent ל-`.exe` יחיד (עם `pkg`).
2. מקמפל installer מלא עם **Inno Setup** — כולל התקנה כשירות Windows והתקנת uninstaller תקין.
3. שם את התוצאה כ-**Artifact** להורדה (בעמוד ה-Actions run, למטה) וגם, אם דוחפים tag כמו `v1.0.0`, מצרף אותה כ-**GitHub Release**.

כדי לקבל release רשמי עם קובץ הורדה קבוע:
```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## 3. התקנה על מחשב לקוח

מריצים את `ContentBlockerAgent-Setup.exe` (מהורד מ-Actions/Release). ה-installer דורש הרשאות מנהל ויבקש אישור UAC אוטומטית — אין צורך ב-"Run as administrator" ידני. ה-installer:
- מתקין את הקבצים (כולל NSSM, שמנהל את השירות)
- רושם ומפעיל שירות Windows בשם `ContentBlockerAgent` שיתחיל אוטומטית עם המחשב, ומוגדר להתאתחל אוטומטית אם הוא קורס
- בהרצה הראשונה, ה-agent נרשם מול השרת ומקבל מזהה ייחודי — הוא יופיע בדשבורד תוך דקה

**לאימות שההתקנה הצליחה:** פתח Task Manager → טאב Services → חפש `ContentBlockerAgent` → ודא שהסטטוס Running.

הסרה: דרך "הוספה/הסרה של תוכניות" בווינדוס (מסירה הכל), **או** מרחוק דרך כפתור "הסר תוכנה" בדשבורד (עוצרת את החסימה, ראה הערה למעלה).

---

## מה יש בדשבורד

- רשימת כל המחשבים שהתקינו את ה-agent, עם סטטוס **מחובר / מנותק** (מתעדכן לפי heartbeat כל ~45 שניות; אם המחשב פורמט או הוסר, הוא הופך ל"מנותק" תוך כ-90 שניות).
- **פתיחה זמנית** — לבחור למספר דקות, ואז החסימה חוזרת אוטומטית.
- **נעילה מיידית** — לבטל פתיחה זמנית לפני הזמן.
- **הסרת תוכנה מרחוק** — שולח פקודה שה-agent מבצע בהתחברות הבאה שלו.
- **מחיקה מהדשבורד** — מסיר את הרשומה בלבד (לא מסיר את התוכנה בפועל אם עדיין מותקנת).

---

## הרחבות שכדאי לשקול

- **רשימת התהליכים החסומים** נמצאת ב-`agent/src/config.js` (`DEFAULT_BLOCKED_PROCESSES`) — אפשר להוסיף שמות של נגני מדיה נוספים. אפשר גם לשלוח עדכון רשימה per-device מהשרת (פקודת `update_rules`, כבר ממומשת ב-agent, רק צריך UI בדשבורד לשלוח אותה).
- חסימת **פתיחת קבצי וידאו** ישירות (לא רק תהליכי נגן) דורשת shell extension או קובץ driver ברמת המערכת — זה מעבר למה שסקריפט Node.js יכול לעשות בבטחה, ומומלץ להתייעץ עם מפתח Windows מנוסה אם זה קריטי.
- **מצלמה לצורכי אבטחה** — אם בעתיד תרצה לוודא שהמשתמש לא עוקף את החסימה, מומלץ מנגנון **שקוף** (אייקון קבוע במגש המערכת + הודעה כשהמצלמה פעילה), לא ניטור סמוי — גם מטעמי חוק וגם מטעמי אמון.
- כרגע האימות בדשבורד הוא סיסמה אחת גלובלית (`ADMIN_PASSWORD`) — לשימוש רב-משתמשים כדאי להוסיף טבלת users אמיתית.

---

## פקודות Git להעלאה ראשונית

```bash
cd content-blocker-suite
git init
git add .
git commit -m "Initial commit: content blocker suite"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```
