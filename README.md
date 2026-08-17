# Content Blocker Suite

מערכת לחסימת תוכנות וידאו/מדיה במחשב מקומי, עם דשבורד ניהול מרוחק.

מורכבת משני חלקים:
- **`agent/`** — תוכנת רקע (Windows Service) שמותקנת על כל מחשב, חוסמת תהליכים לפי רשימה, ומדווחת לשרת.
- **`server/`** — API + דשבורד web, מיועד לדפלוי ל-[Render](https://render.com).

---

## 1. הקמת השרת (Render)

1. צור repo חדש ב-GitHub והעלה אליו את כל התיקייה הזו (ראה פקודות בסוף).
2. ב-[Render](https://dashboard.render.com) → **New → Blueprint** → חבר את ה-repo. Render יזהה אוטומטית את `server/render.yaml` ויקים web service + מסד Postgres.
3. אחרי הפריסה, בכרטיסיית **Environment** של השירות, הגדר:
   - `ADMIN_PASSWORD` — הסיסמה שלך לכניסה לדשבורד.
4. גש לכתובת שRender נתן (`https://your-app.onrender.com`) — אמור להופיע מסך התחברות לדשבורד.

**הרצה מקומית (לבדיקות):**
```bash
cd server
cp .env.example .env   # ומלא DATABASE_URL אמיתי + ADMIN_PASSWORD
npm install
npm start
```

---

## 2. בניית ה-installer (אוטומטי דרך GitHub Actions)

לפני שתעלה ל-GitHub, ערוך את `agent/src/config.js` ושנה את:
```js
SERVER_URL: process.env.CB_SERVER_URL || 'https://your-app.onrender.com',
```
לכתובת האמיתית של השרת שלך מ-Render.

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

מריצים את `ContentBlockerAgent-Setup.exe` (מהורד מ-Actions/Release) במחשב היעד עם הרשאות מנהל. ה-installer:
- מתקין את הקבצים
- רושם ומפעיל שירות Windows בשם `ContentBlockerAgent` שיתחיל אוטומטית עם המחשב
- בהרצה הראשונה, ה-agent נרשם מול השרת ומקבל מזהה ייחודי — הוא יופיע בדשבורד תוך דקה

הסרה: דרך "הוספה/הסרה של תוכניות" בווינדוס, **או** מרחוק דרך כפתור "הסר תוכנה" בדשבורד.

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
