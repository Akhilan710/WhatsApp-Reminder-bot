// index.js - WhatsApp Bot Web Server with Persistent Session, Enhanced Reminders, and Rescheduling
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const { Client, LocalAuth, MessageMedia, Buttons } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const XLSX = require("xlsx");
const dayjs = require("dayjs");
const axios = require("axios");
const fs = require("fs");

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "uploads/" });

// Configure middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

// Global variables for application state
let whatsappClient = null;
let appointmentData = [];
let reminderInterval = null;
let isInitializing = false;
let currentQrCode = null;
let availableSlots = [];  // Store available slots for rescheduling
let userReschedulingState = {};  // Track users who are in the rescheduling process

// Excel file path for saving updated appointments
const EXCEL_FILE_PATH = process.env.EXCEL_FILE_PATH || "./appointments.xlsx";

// Initialize WhatsApp client with existing auth - only once
function initializeWhatsAppClient() {
  // Prevent multiple initialization attempts
  if (whatsappClient || isInitializing) {
    console.log("WhatsApp client already exists or is initializing");
    return;
  }
  
  isInitializing = true;
  console.log("Initializing WhatsApp client...");
  
  // Use LocalAuth strategy to maintain session persistence
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, '.wwebjs_auth') // Specify auth data directory
    }),
    puppeteer: {
      // Changed to true to avoid showing browser window, QR will be displayed in UI
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  // Handle QR code event
  whatsappClient.on("qr", (qr) => {
    console.log("📲 Scan this QR code to log in:");
    qrcode.generate(qr, { small: true });
    
    // Store QR code for web interface
    currentQrCode = qr;
    app.locals.qrCode = qr;
  });

  // Handle ready event
  whatsappClient.on("ready", () => {
    console.log("✅ WhatsApp client ready and authenticated");
    app.locals.whatsappConnected = true;
    isInitializing = false;
    currentQrCode = null; // Clear the QR code since authenticated
    
    // Start the reminder scheduler
    startReminderLoop();
  });

  // Handle authentication failure
  whatsappClient.on("auth_failure", (msg) => {
    console.error("❌ Authentication failure:", msg);
    app.locals.whatsappConnected = false;
    isInitializing = false;
    
    // Don't null the client so we can retry connecting
  });

  // Handle disconnection
  whatsappClient.on("disconnected", (reason) => {
    console.log("❌ WhatsApp client disconnected:", reason);
    app.locals.whatsappConnected = false;
    isInitializing = false;
    currentQrCode = null; // Clear the QR code when disconnected
    
    // Keep the client instance but mark as disconnected
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }
  });

  // Handle incoming messages - IMPORTANT FOR RESCHEDULING
  whatsappClient.on("message", async (message) => {
    try {
      const contact = await message.getContact();
      const phone = contact.number;
      const messageContent = message.body.toLowerCase();
      
      // Check if this is a rescheduling request
      if (messageContent.includes("reschedule")) {
        console.log(`Received reschedule request from ${phone}`);
        
        // Add 6-second delay before responding
        setTimeout(async () => {
          await handleRescheduleRequest(phone, message);
        }, 6000); // 6 seconds delay
      } 
      // Check if the user is in the rescheduling process and has selected a date/time
      else if (userReschedulingState[phone]) {
        // Add a short delay before responding to selection
        setTimeout(async () => {
          await handleRescheduleSelection(phone, messageContent, message);
        }, 2000); // 2 seconds delay for better user experience
      }
    } catch (err) {
      console.error("❌ Error handling incoming message:", err.message);
    }
  });
  
  // Handle button clicks for the new button-based UI
  whatsappClient.on("message_create", async (message) => {
    // Only process messages from others (not from ourselves)
    if (message.fromMe) return;
    
    try {
      // Check if it's a button response
      if (message.type === "buttons_response") {
        const buttonId = message.selectedButtonId;
        const contact = await message.getContact();
        const phone = contact.number;
        
        console.log(`Received button selection: ${buttonId} from ${phone}`);
        
        // Process the button click if the user is in the rescheduling process
        if (userReschedulingState[phone]) {
          // Add a short delay before responding
          setTimeout(async () => {
            await handleRescheduleSelection(phone, buttonId, message);
          }, 2000); // 2 seconds delay for better user experience
        }
      }
    } catch (err) {
      console.error("❌ Error handling button response:", err.message);
    }
  });

  // Initialize the client
  whatsappClient.initialize().catch(err => {
    console.error("Failed to initialize WhatsApp client:", err);
    isInitializing = false;
  });
}

// Function to send button messages in batches
async function sendButtonsInBatches(phone, title, options, introMessage, type = 'date') {
  try {
    // First send the intro message
    if (introMessage) {
      await whatsappClient.sendMessage(`${phone}@c.us`, introMessage);
      
      // Small delay between messages
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Send buttons in batches of 3 (WhatsApp limit)
    const batchSize = 3;
    for (let i = 0; i < options.length; i += batchSize) {
      const batch = options.slice(i, i + batchSize);
      const buttonRows = batch.map((option) => ({
        id: `${type}_${i + batch.indexOf(option)}`,
        title: option
      }));
      
      // Create button message
      const buttons = new Buttons(
        `Select ${type === 'date' ? 'a date' : 'a time'} (${i+1}-${Math.min(i+batchSize, options.length)} of ${options.length})`, 
        buttonRows,
        type === 'date' ? 'Available Dates' : 'Available Times',
        'Tap a button below'
      );
      
      // Send button message
      await whatsappClient.sendMessage(`${phone}@c.us`, buttons);
      
      // Add a short delay between batches of buttons
      if (i + batchSize < options.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error sending button batches: ${error.message}`);
    return false;
  }
}

// Function to handle initial reschedule requests
async function handleRescheduleRequest(phone, message) {
  try {
    // Find if this user has an appointment
    const userAppointment = appointmentData.find(appt => appt.phone === phone);
    
    if (!userAppointment) {
      await message.reply("We couldn't find any appointments associated with this number. Please contact our office directly for assistance.");
      return;
    }
    
    // Generate available slots for rescheduling that don't overlap with existing appointments
    const availableDates = generateAvailableSlots(userAppointment);
    
    if (availableDates.length === 0) {
      await message.reply("We're sorry, but there are no available appointment slots at the moment. Please try again later or contact our office directly for assistance.");
      return;
    }
    
    // Store the user's state
    userReschedulingState[phone] = {
      currentAppointment: userAppointment,
      availableDates: availableDates,
      stage: 'selecting_date'
    };
    
    // Format date options for better readability
    const dateOptions = availableDates.map(date => {
      const [dateStr, dayName] = date.dateStr.split(' ');
      return dayjs(dateStr).format(`MMM D (${dayName})`);
    });
    
    // Create intro message with current appointment info
    const introMessage = `Hello ${userAppointment.name}, your current appointment is on ${dayjs(userAppointment.appointmentTime).format('MMM D, YYYY [at] h:mm A')}.\n\nTo reschedule, please select a new date:`;
    
    // Send date options as buttons in batches
    const buttonsSent = await sendButtonsInBatches(
      phone, 
      'Available Dates', 
      dateOptions, 
      introMessage,
      'date'
    );
    
    // Fallback to text message if buttons fail
    if (!buttonsSent) {
      let replyMessage = "Please choose one of the available dates for rescheduling:\n\n";
      dateOptions.forEach((date, index) => {
        replyMessage += `${index + 1}. ${date}\n`;
      });
      replyMessage += "\nReply with the number of your preferred date.";
      
      await message.reply(replyMessage);
    }
  } catch (err) {
    console.error("❌ Error handling reschedule request:", err.message);
    await message.reply("Sorry, there was an error processing your request. Please try again later.");
  }
}

// Function to handle user's selection during rescheduling
async function handleRescheduleSelection(phone, messageContent, message) {
  try {
    const userState = userReschedulingState[phone];
    
    // If user is selecting a date
    if (userState.stage === 'selecting_date') {
      let selectedDateIndex = -1;
      
      // Check if this is a button response (format: date_X)
      if (messageContent.startsWith('date_')) {
        selectedDateIndex = parseInt(messageContent.replace('date_', ''));
      } else {
        // Try to parse as a number response
        selectedDateIndex = parseInt(messageContent) - 1;
      }
      
      if (isNaN(selectedDateIndex) || selectedDateIndex < 0 || selectedDateIndex >= userState.availableDates.length) {
        await message.reply("Invalid selection. Please try again with a valid selection from the list.");
        return;
      }
      
      // Store selected date and move to time selection
      userState.selectedDate = userState.availableDates[selectedDateIndex];
      userState.stage = 'selecting_time';
      
      // Get time slots for the selected date
      const timeSlots = userState.selectedDate.timeSlots;
      
      // Format time slots for better readability
      const formattedTimeSlots = timeSlots.map(timeSlot => {
        const [hour, minute] = timeSlot.split(':');
        return dayjs().hour(hour).minute(minute).format('h:mm A');
      });
      
      // Send time options as buttons
      const [dateStr, dayName] = userState.selectedDate.dateStr.split(' ');
      const introMessage = `Great! For ${dayjs(dateStr).format('MMM D')} (${dayName}), please select a time:`;
      
      // Send time slots as buttons in batches
      const buttonsSent = await sendButtonsInBatches(
        phone,
        'Available Times',
        formattedTimeSlots,
        introMessage,
        'time'
      );
      
      // Fallback to text message if buttons fail
      if (!buttonsSent) {
        let timeMessage = `Please select an available time for ${dayjs(dateStr).format('MMM D')} (${dayName}):\n\n`;
        formattedTimeSlots.forEach((timeSlot, index) => {
          timeMessage += `${index + 1}. ${timeSlot}\n`;
        });
        timeMessage += "\nReply with the number of your preferred time.";
        
        await message.reply(timeMessage);
      }
    }
    
    // If user is selecting a time
    else if (userState.stage === 'selecting_time') {
      // Rest of your time selection handling code remains the same
      // ...

      // Just change the way we handle the selectedTime to work with formatted time slots
      let selectedTimeIndex = -1;
      
      // Check if this is a button response (format: time_X)
      if (messageContent.startsWith('time_')) {
        selectedTimeIndex = parseInt(messageContent.replace('time_', ''));
      } else {
        // Try to parse as a number response
        selectedTimeIndex = parseInt(messageContent) - 1;
      }
      
      if (isNaN(selectedTimeIndex) || selectedTimeIndex < 0 || selectedTimeIndex >= userState.selectedDate.timeSlots.length) {
        await message.reply("Invalid selection. Please try again with a valid selection from the list.");
        return;
      }
      
      // Get original (unformatted) selected time from our stored data
      const selectedTime = userState.selectedDate.timeSlots[selectedTimeIndex];
      
      // Continue with your existing logic for updating the appointment...
    }
    
  } catch (err) {
    console.error("❌ Error handling reschedule selection:", err.message);
    await message.reply("Sorry, there was an error processing your selection. Please try again later.");
    delete userReschedulingState[phone]; // Clear state on error
  }
}

// Check if a time slot is available (not booked by someone else)
function isTimeSlotAvailable(proposedTime, userPhone) {
  const proposedTimeObj = dayjs(proposedTime);
  
  // Consider a slot unavailable if it's within the same hour as another appointment
  for (const appointment of appointmentData) {
    // Skip the user's own current appointment
    if (appointment.phone === userPhone) continue;
    
    const apptTime = dayjs(appointment.appointmentTime);
    
    // Check if the proposed time is on the same day and within 1 hour of any existing appointment
    if (
      proposedTimeObj.format('YYYY-MM-DD') === apptTime.format('YYYY-MM-DD') &&
      Math.abs(proposedTimeObj.diff(apptTime, 'hour', true)) < 1
    ) {
      return false; // Time slot not available
    }
  }
  
  return true; // Time slot is available
}

// Generate available slots for rescheduling that don't overlap with existing appointments
function generateAvailableSlots(currentUserAppointment) {
  const slots = [];
  const now = dayjs();
  
  // Generate slots for the next 14 days (increased from 7 to give more options)
  for (let i = 1; i <= 14; i++) {
    const date = now.add(i, 'day');
    const dateStr = date.format('YYYY-MM-DD dddd');
    
    // Skip Sunday for weekend
    if (date.day() === 0) continue;
    
    // Generate all possible time slots based on business hours
    let allTimeSlots = [];
    if (date.day() !== 6) { // Monday-Friday
      for (let hour = 9; hour <= 16; hour++) {
        allTimeSlots.push(`${hour}:00`);
        if (hour < 16) allTimeSlots.push(`${hour}:30`);
      }
    } else { // Saturday
      for (let hour = 9; hour <= 12; hour++) {
        allTimeSlots.push(`${hour}:00`);
        if (hour < 12) allTimeSlots.push(`${hour}:30`);
      }
    }
    
    // Filter out time slots that overlap with existing appointments
    const availableTimeSlots = allTimeSlots.filter(timeSlot => {
      const [hour, minute = '00'] = timeSlot.split(':');
      const proposedTime = dayjs(`${date.format('YYYY-MM-DD')}T${hour.padStart(2, '0')}:${minute}`);
      return isTimeSlotAvailable(proposedTime, currentUserAppointment.phone);
    });

    if (availableTimeSlots.length > 0) {
      slots.push({
        dateStr,
        timeSlots: availableTimeSlots
      });
    }
  }

  return slots;
}


// Save appointments to Excel file
function saveAppointmentsToExcel() {
  try {
    // Convert appointment data back to format suitable for Excel
    const formattedData = appointmentData.map(appointment => ({
      name: appointment.name,
      phone: appointment.phone,
      appointmentTime: dayjs(appointment.appointmentTime).format('YYYY-MM-DD HH:mm')
    }));
    
    // Create a new workbook and worksheet
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(formattedData);
    
    // Add the worksheet to the workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Appointments');
    
    // Write to file
    XLSX.writeFile(workbook, EXCEL_FILE_PATH);
    
    console.log(`✅ Updated appointments saved to ${EXCEL_FILE_PATH}`);
    return true;
  } catch (err) {
    console.error("❌ Error saving appointments to Excel:", err.message);
    return false;
  }
}

// Serve the home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle Excel file upload - WITH FIXED PHONE NUMBER HANDLING
app.post("/upload", upload.single("excelFile"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // Read the Excel file
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert to JSON with raw values to properly handle numbers
    const rawData = XLSX.utils.sheet_to_json(worksheet, { 
      raw: true // Keep raw values to handle phone numbers correctly
    });
    
    // Validate and format the data
    const validData = rawData.filter(row => 
      row.name && row.phone && row.appointmentTime
    ).map(row => {
      // Handle phone number - improved scientific notation handling
      let phoneStr;
      if (typeof row.phone === 'number') {
        // Convert to full number without scientific notation
        phoneStr = row.phone.toLocaleString('fullwide', {useGrouping: false});
      } else {
        phoneStr = row.phone.toString();
      }
      
      // Clean phone number (remove any non-digit characters)
      phoneStr = phoneStr.replace(/[^\d]/g, "");
      
      // Handle appointment time parsing
      let appointmentDateTime;
      
      if (typeof row.appointmentTime === 'number') {
        // It's an Excel serial number date
        const dateInfo = XLSX.SSF.parse_date_code(row.appointmentTime);
        appointmentDateTime = new Date(
          dateInfo.y, 
          dateInfo.m - 1, 
          dateInfo.d, 
          dateInfo.H || 0, 
          dateInfo.M || 0
        ).toISOString();
      } else if (typeof row.appointmentTime === 'string') {
        // Try parsing as string date
        appointmentDateTime = dayjs(row.appointmentTime).toISOString();
      } else if (row.appointmentTime instanceof Date) {
        // It's already a Date object
        appointmentDateTime = row.appointmentTime.toISOString();
      } else {
        // Default to current date+time if parsing fails
        console.warn(`Could not parse date for ${row.name}: ${row.appointmentTime}`);
        appointmentDateTime = new Date().toISOString();
      }
      
      return {
        name: row.name,
        phone: phoneStr,
        appointmentTime: appointmentDateTime
      };
    });
    
    if (validData.length === 0) {
      return res.status(400).json({ 
        error: "Excel file must contain columns: name, phone, appointmentTime" 
      });
    }
    
    // Store the appointment data
    appointmentData = validData;
    
    // Save a copy of the appointments
    saveAppointmentsToExcel();
    
    // Format dates for display in frontend
    const formattedAppointments = validData.map(appointment => ({
      name: appointment.name,
      phone: appointment.phone,
      appointmentTime: dayjs(appointment.appointmentTime).format('YYYY-MM-DD HH:mm')
    }));
    
    // Clean up the uploaded file
    fs.unlinkSync(req.file.path);
    
    // Restart reminder loop with new data
    startReminderLoop();
    
    return res.json({ 
      success: true, 
      message: `Successfully loaded ${validData.length} appointments`,
      appointments: formattedAppointments,
      whatsappStatus: app.locals.whatsappConnected ? "connected" : "disconnected"
    });
  } catch (error) {
    console.error("❌ Error processing Excel file:", error);
    return res.status(500).json({ error: "Failed to process Excel file: " + error.message });
  }
});

// Initialize WhatsApp connection - only if not already connected
app.post("/connect-whatsapp", (req, res) => {
  if (whatsappClient && app.locals.whatsappConnected) {
    return res.json({ 
      success: true, 
      message: "WhatsApp is already connected" 
    });
  }
  
  // If client exists but is disconnected, try to reconnect
  if (whatsappClient && !app.locals.whatsappConnected && !isInitializing) {
    whatsappClient.initialize().catch(err => {
      console.error("Failed to reinitialize WhatsApp client:", err);
    });
    
    return res.json({
      success: true,
      message: "Attempting to reconnect WhatsApp client. Please wait."
    });
  }

  // If no client exists, initialize a new one
  if (!whatsappClient && !isInitializing) {
    initializeWhatsAppClient();
  }
  
  return res.json({ 
    success: true, 
    message: "WhatsApp client initializing. Please wait for QR code if needed." 
  });
});

// Get QR code
app.get("/qr-code", (req, res) => {
  if (currentQrCode) {
    return res.json({ qrCode: currentQrCode });
  } else {
    return res.status(404).json({ error: "QR code not available yet" });
  }
});

// Check WhatsApp connection status
app.get("/whatsapp-status", (req, res) => {
  return res.json({ 
    connected: app.locals.whatsappConnected || false,
    initializing: isInitializing || false
  });
});

// Manual disconnect endpoint (for testing)
app.post("/disconnect-whatsapp", async (req, res) => {
  if (!whatsappClient) {
    return res.json({ success: false, message: "No WhatsApp client to disconnect" });
  }
  
  try {
    // Properly logout and disconnect
    await whatsappClient.destroy();
    app.locals.whatsappConnected = false;
    currentQrCode = null; // Clear the QR code
    
    if (reminderInterval) {
      clearInterval(reminderInterval);
      reminderInterval = null;
    }
    
    // Don't set whatsappClient to null to allow reconnection
    return res.json({ success: true, message: "WhatsApp client disconnected" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Error disconnecting: " + err.message });
  }
});

// Start reminder scheduler with enhanced daily countdown reminders
function startReminderLoop() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
  }
  
  reminderInterval = setInterval(async () => {
    try {
      if (!appointmentData.length) return;
      
      const now = dayjs();
      
      for (const appointment of appointmentData) {
        const apptTime = dayjs(appointment.appointmentTime);
        
        // Check for daily countdown reminders (7 days to 1 day before)
        const daysUntilAppointment = apptTime.startOf('day').diff(now.startOf('day'), 'day');
        
        // Send daily reminders if it's 11:30 AM and appointment is within the next week (7 days)
        if (now.format("HH:mm") === "11:30" && daysUntilAppointment > 0 && daysUntilAppointment <= 7) {
          // Generate custom countdown message
          const countdownMessage = await getCountdownMessage({
            name: appointment.name,
            apptTimeStr: apptTime.format("YYYY-MM-DD HH:mm"),
            daysToGo: daysUntilAppointment,
            dayOfWeek: apptTime.format("dddd")
          });
          
          // Add rescheduling option to the message
          const messageWithReschedule = `${countdownMessage}\n\nNeed to reschedule? Just reply with "reschedule" and we'll help you find a new time.`;
          
          // Send message
          if (whatsappClient && app.locals.whatsappConnected) {
            await sendWhatsAppMessage(`${appointment.phone}@c.us`, messageWithReschedule);
            console.log(`Sent ${daysUntilAppointment}-day countdown reminder to ${appointment.name}`);
          }
        }
        
        // Original 5-hour reminder logic
        const reminderTime = apptTime.subtract(5, "hour");
        
        // Check if it's time to send the 5-hour reminder
        if (now.format("YYYY-MM-DD HH:mm") === reminderTime.format("YYYY-MM-DD HH:mm")) {
          // Generate custom same-day reminder message
          const message = await getSameDayReminderMessage({
            name: appointment.name,
            apptTimeStr: apptTime.format("YYYY-MM-DD HH:mm")
          });
          
          // Add rescheduling option to the message
          const messageWithReschedule = `${message}\n\nNeed to reschedule? Just reply with "reschedule" and we'll help you find a new time.`;
          
          // Send message
          if (whatsappClient && app.locals.whatsappConnected) {
            await sendWhatsAppMessage(`${appointment.phone}@c.us`, messageWithReschedule);
            console.log(`Sent 5-hour reminder to ${appointment.name}`);
          }
        }
      }
    } catch (err) {
      console.error("❌ Error in reminder loop:", err.message);
    }
  }, 60000); // Check every minute
}

// Generate countdown reminder messages
async function getCountdownMessage({ name, apptTimeStr, daysToGo, dayOfWeek }) {
  // If GROQ API key is not available, use a template message
  if (!process.env.GROQ_API_KEY) {
    return `Hi ${name}, just a reminder that your appointment is on ${dayOfWeek} (${daysToGo} day${daysToGo > 1 ? 's' : ''} to go). See you then!`;
  }
  
  try {
    const prompt = `Write a friendly WhatsApp reminder for ${name} that their appointment is scheduled on ${dayOfWeek} which is ${daysToGo} day${daysToGo > 1 ? 's' : ''} from today. This is a daily countdown reminder. Keep it short, friendly and clear.`;
    const body = {
      messages: [{ role: "user", content: prompt }],
      model: "llama3-8b-8192",
    };

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", body, {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error generating countdown message:", error);
    // Fallback to template message
    return `Hi ${name}, just a reminder that your appointment is on ${dayOfWeek} (${daysToGo} day${daysToGo > 1 ? 's' : ''} to go). See you then!`;
  }
}

// Generate same-day reminder messages (5 hours before appointment)
async function getSameDayReminderMessage({ name, apptTimeStr }) {
  // If GROQ API key is not available, use a template message
  if (!process.env.GROQ_API_KEY) {
    return `Hi ${name}, this is a reminder that your appointment is scheduled for today at ${dayjs(apptTimeStr).format("HH:mm")}. We look forward to seeing you soon!`;
  }
  
  try {
    const prompt = `Write a friendly WhatsApp reminder for ${name} that their appointment is scheduled at ${dayjs(apptTimeStr).format("HH:mm")} TODAY, just 5 hours from now. Keep it short and clear.`;
    const body = {
      messages: [{ role: "user", content: prompt }],
      model: "llama3-8b-8192",
    };

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", body, {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("❌ Error generating same-day reminder message:", error);
    // Fallback to template message
    return `Hi ${name}, this is a reminder that your appointment is scheduled for today at ${dayjs(apptTimeStr).format("HH:mm")}. We look forward to seeing you soon!`;
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
    await whatsappClient.sendMessage(to, message);
    console.log(`✅ Reminder sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send to ${to}:`, err.message);
    return false;
  }
}

// Auto-initialize WhatsApp client when server starts
// This allows reconnection to existing session
initializeWhatsAppClient();

// Start the Express server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});