# 📆 WhatsApp AI Appointment Reminder Bot

This is a smart WhatsApp bot that sends automated appointment reminders and allows clients to **reschedule via chat**. Includes a clean web interface for uploading Excel data, tracking statuses, and managing WhatsApp connection.

---

## ✨ Features

- 📤 Upload Excel file with `name`, `phone`, `appointmentTime`
- 🔄 Smart rescheduling via WhatsApp using buttons
- ⏰ Auto-reminders sent 7 days before and on the appointment day
- 📊 Upload and manage status responses (e.g., yes/no)
- 🧹 Clear data memory with admin PIN
- 🖥️ Web interface for file uploads and system control
- 🤖 AI-generated messages via [Groq API](https://console.groq.com) (LLaMA models)

---

## 🚀 Installation

### 1. **Clone the Repo or Copy the Folder**

git clone https://github.com/yourusername/whatsapp-ai-bot.git
cd whatsapp-ai-bot

### 3. Install Dependencies
npm install

📁 Uploading Files
Appointments Excel File

Columns required: name, phone, appointmentTime

Status Sheet File

Columns required: name, phone, status

💡 If You Want to Install Individually (clean slate):

npm install express multer xlsx dayjs dotenv axios qrcode qrcode-terminal whatsapp-web.js googleapis
npm install --save-dev nodemon
