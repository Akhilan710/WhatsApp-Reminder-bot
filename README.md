# WhatsApp-Reminder-bot
# 📲 WhatsApp Appointment Reminder & Rescheduling System

This project allows users to upload an Excel sheet of client appointment data, preview it in a web interface, and send personalized WhatsApp reminders or reschedule messages via WhatsApp Web using **Venom Bot**.

---

## 🛠️ Features

- Upload Excel files (`.xlsx`) with appointment data
- Preview and validate client details in the browser
- Connect to WhatsApp Web via QR Code
- Send appointment **reminders** or **rescheduling messages**
- Custom message templating (editable in code)
- Automatically schedules messages based on appointment time

---

## 📦 Tech Stack

- **Frontend:** HTML + JavaScript + Bootstrap
- **Backend:** Node.js + Express
- **WhatsApp Bot:** [Venom Bot](https://github.com/orkestral/venom)
- **Excel Parsing:** `xlsx`
- **File Uploads:** `multer`
- **Date Handling:** `moment`

---

## 🚀 Getting Started

### ✅ Prerequisites

Ensure the following are installed:

- Node.js (v16+ recommended) – [Download Node.js](https://nodejs.org/)
- npm or yarn
- Git (optional)

---

### 📦 Install Dependencies

npm install express multer xlsx venom-bot cors body-parser moment


```bash
npm install

This installs:

express
multer
xlsx
venom-bot
cors
body-parser
moment

Optional for development:

npm install --save-dev nodemon

📂 Excel File Format

The uploaded .xlsx file must have the following columns:

Example 

name	             phone                                    appointmentTime
	
 XYZ               919876543210                               2025-05-10T15:00:00  ISO string or formatted datetime

🧑‍💻 Running the Server


# For production
npm start

