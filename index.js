// index.js - WhatsApp Bot Web Server with Persistent Session, Enhanced Reminders, and Text-Based Rescheduling
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
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
let userReschedulingState = {};  // Track users who are in the rescheduling process
let statusSheetData = []; // Store status sheet data

// Excel file path for saving updated appointments
const EXCEL_FILE_PATH = process.env.EXCEL_FILE_PATH || "./appointments.xlsx";
const STATUS_FILE_PATH = "./status.json";
const SEEN_APPOINTMENTS_FILE = './seenAppointments.json';


// Business hours configuration - NEW
const BUSINESS_HOURS = {
  // For each day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  0: { open: null, close: null }, // Sunday - closed
  1: { open: "10:00", close: "21:00" }, // Monday
  2: { open: "10:00", close: "21:00" }, // Tuesday
  3: { open: "10:00", close: "21:00" }, // Wednesday
  4: { open: "10:00", close: "21:00" }, // Thursday
  5: { open: "10:00", close: "21:00" }, // Friday
  6: { open: "10:00", close: "21:00" }  // Saturday
};

// Time slot duration in minutes - each appointment takes this long
const TIME_SLOT_DURATION = 60; // 1 hour slots

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
  // Handle incoming messages - UPDATED WITH CANCELLATION HANDLER
  // Handle incoming messages - UPDATED WITH CASE-INSENSITIVE RESCHEDULE HANDLING
  // Replace your existing message handler with this filtered version
  whatsappClient.on("message", async (message) => {
    try {
      const contact = await message.getContact();
      const phone = contact.number;
      const messageContent = message.body.toLowerCase();

      // ONLY process messages from users who have appointments
      const userAppointment = appointmentData.find(appt => appt.phone === phone);
      if (!userAppointment) {
        // Silently ignore messages from non-appointment users
        return;
      }

      // ONLY process text messages (ignore images/media)
      if (message.hasMedia) {
        return;
      }

      console.log(`📱 Message from ${userAppointment.name} (${phone}): "${message.body}"`);

      // FIRST: Check if user is in a specific state (confirmation or rescheduling)
      if (userReschedulingState[phone]) {
        const userState = userReschedulingState[phone];

        // Handle cancellation confirmation
        if (userState.stage === 'confirming_cancellation') {
          console.log(`User ${phone} is in cancellation confirmation stage`);

          if (messageContent.includes("confirm cancel") ||
            messageContent.includes("confirm") ||
            (messageContent === "cancel" && userState.stage === 'confirming_cancellation') ||
            messageContent === "yes") {

            console.log(`Processing confirmed cancellation for ${phone}`);
            setTimeout(async () => {
              await processCancellation(phone, message);
            }, 5000);
            return;
          }
          else if (messageContent.includes("reschedule")) {
            console.log(`User ${phone} chose to reschedule instead of cancel`);
            setTimeout(async () => {
              await handleRescheduleRequest(phone, message);
            }, 5000);
            return;
          }
          else {
            setTimeout(async () => {
              await message.reply("I'm not sure what you'd like to do. Please reply with either \"CONFIRM CANCEL\" to cancel your appointment, or \"RESCHEDULE\" to find a new time.");
            }, 5000);
            return;
          }
        }

        // Handle date selection during rescheduling
        else if (userState.stage === 'selecting_date') {
          setTimeout(async () => {
            await handleDateSelection(phone, messageContent, message);
          }, 5000);
          return;
        }

        // Handle time selection during rescheduling
        else if (userState.stage === 'selecting_time') {
          setTimeout(async () => {
            await handleTimeSelection(phone, messageContent, message);
          }, 5000);
          return;
        }
      }

      // SECOND: Handle initial requests (only if user is NOT in any specific state)
      // Check for initial cancellation request
      if (messageContent.includes("cancel") || messageContent.includes("cancellation")) {
        console.log(`Received initial cancellation request from ${phone}`);
        setTimeout(async () => {
          await handleCancellationRequest(phone, message);
        }, 5000);
      }
      // Check for initial rescheduling request
      else if (messageContent.includes("reschedule")) {
        console.log(`Received initial reschedule request from ${phone}`);
        setTimeout(async () => {
          await handleRescheduleRequest(phone, message);
        }, 5000);
      }

    } catch (err) {
      console.error("❌ Error handling incoming message:", err.message);
    }
  });

  // Initialize the client
  whatsappClient.initialize().catch(err => {
    console.error("Failed to initialize WhatsApp client:", err);
    isInitializing = false;
  });
}

// Function to handle initial reschedule requests
async function handleRescheduleRequest(phone, message) {
  try {
    // Find if this user has an appointment
    const userAppointment = appointmentData.find(appt => appt.phone === phone);

    if (!userAppointment) {
      // Add 5-second delay before responding
      await new Promise(resolve => setTimeout(resolve, 5000));
      await message.reply("We couldn't find any appointments associated with this number. Please contact our office directly for assistance.");
      return;
    }

    // Get the next 7 available dates
    const availableDates = getAvailableDates(7);

    if (availableDates.length === 0) {
      // Add 5-second delay before responding
      await new Promise(resolve => setTimeout(resolve, 5000));
      await message.reply("We're sorry, but there are no available appointment dates at the moment. Please try again later or contact our office directly for assistance.");
      return;
    }

    // Store the user's state
    userReschedulingState[phone] = {
      currentAppointment: userAppointment,
      availableDates: availableDates,
      stage: 'selecting_date'
    };

    // Format date options for better readability
    const dateOptions = availableDates.map((date, index) => {
      return `${index + 1}. ${dayjs(date).format('dddd, MMMM D, YYYY')}`;
    }).join('\n');

    // Create intro message with current appointment info
    const introMessage = `Hello ${userAppointment.name}, your current appointment is on ${dayjs(userAppointment.appointmentTime).format('dddd, MMMM D, YYYY [at] h:mm A')}.\n\nTo reschedule, please reply with the number of your preferred date:\n\n${dateOptions}\n\nFor example, reply with "1" to select the first date.`;

    // Add 5-second delay before responding
    await new Promise(resolve => setTimeout(resolve, 5000));
    await message.reply(introMessage);

  } catch (err) {
    console.error("❌ Error handling reschedule request:", err.message);
    // Add 5-second delay before responding
    await new Promise(resolve => setTimeout(resolve, 5000));
    await message.reply("Sorry, there was an error processing your request. Please try again later.");
  }
}

// Function to handle date selection
async function handleDateSelection(phone, messageContent, message) {
  try {
    const userState = userReschedulingState[phone];

    // Try to parse the selected date index
    const selectedDateIndex = parseInt(messageContent.trim()) - 1;

    if (isNaN(selectedDateIndex) || selectedDateIndex < 0 || selectedDateIndex >= userState.availableDates.length) {
      // Add 5-second delay before responding
      await new Promise(resolve => setTimeout(resolve, 5000));
      await message.reply("Invalid selection. Please enter a number from the list of dates.");
      return;
    }

    // Store selected date and move to time selection
    const selectedDate = userState.availableDates[selectedDateIndex];
    userState.selectedDate = selectedDate;
    userState.stage = 'selecting_time';

    // Get available time slots for the selected date
    const timeSlots = getAvailableTimeSlots(selectedDate, phone);

    if (timeSlots.length === 0) {
      // Add 5-second delay before responding
      await new Promise(resolve => setTimeout(resolve, 5000));
      await message.reply("We're sorry, but there are no available time slots for this date. Please select another date.");
      userState.stage = 'selecting_date';
      return;
    }

    // Store the available time slots
    userState.availableTimeSlots = timeSlots;

    // Format time slots for display
    const formattedTimeSlots = timeSlots.map(slot => {
      return dayjs(slot).format('h:mm A');
    }).join(', ');

    // Send available time slots message
    const timeMessage = `For ${dayjs(selectedDate).format('dddd, MMMM D, YYYY')}, the available time slots are:\n\n${formattedTimeSlots}\n\nPlease reply with your preferred time (e.g., "2 PM" or "2:00 PM").`;

    // Add 5-second delay before responding
    await new Promise(resolve => setTimeout(resolve, 5000));
    await message.reply(timeMessage);

  } catch (err) {
    console.error("❌ Error handling date selection:", err.message);
    // Add 5-second delay before responding
    await new Promise(resolve => setTimeout(resolve, 5000));
    await message.reply("Sorry, there was an error processing your selection. Please try again later.");
    delete userReschedulingState[phone]; // Clear state on error
  }
}

// Function to handle time selection
// Replace the existing handleTimeSelection function with this improved version
// Function to handle time selection with better time format parsing
// Enhanced handleTimeSelection function with comprehensive time format parsing
async function handleTimeSelection(phone, messageContent, message) {
  try {
    const userState = userReschedulingState[phone];

    // Clean and normalize the input time
    const inputTime = messageContent.trim().toLowerCase().replace(/\s+/g, ' ');
    let selectedTime = null;

    // Define comprehensive regex patterns for different time formats
    const timeFormats = [
      // Standard formats: 2pm, 2PM, 2 pm, 2 PM
      /^(\d{1,2})\s*(?:pm|am)$/i,

      // With colon: 2:00pm, 2:00PM, 2:00 pm, 2:00 PM
      /^(\d{1,2}):(\d{2})\s*(?:pm|am)$/i,

      // With colon but no minutes: 2:pm, 2: pm, 2:PM, 2: PM  
      /^(\d{1,2}):\s*(?:pm|am)$/i,

      // Mixed case variations: 2pM, 2Pm, 2aM, 2Am
      /^(\d{1,2})\s*(?:pm|am)$/i,

      // With colon and mixed case: 2:00pM, 2:00Pm, 6:pM, 6:Pm
      /^(\d{1,2}):?(\d{2})?\s*(?:pm|am)$/i,

      // Just number: "2", "14", "6" (we'll infer AM/PM from available slots)
      /^(\d{1,2})$/,

      // With colon only: "6:", "14:", "2:"
      /^(\d{1,2}):$/,

      // 24-hour format: "14:00", "06:30"
      /^(\d{1,2}):(\d{2})$/
    ];

    // Try to parse using the comprehensive approach
    let matchedFormat = false;
    let matchedHour = null;
    let matchedMinute = 0;
    let matchedPeriod = null;
    let is24HourFormat = false;

    // Try each regex pattern
    for (const pattern of timeFormats) {
      const match = inputTime.match(pattern);
      if (match) {
        matchedFormat = true;
        matchedHour = parseInt(match[1]);

        // Handle minutes if present
        if (match[2] && match[2] !== '') {
          matchedMinute = parseInt(match[2]);
        }

        // Determine AM/PM from the input
        if (inputTime.includes('pm')) {
          matchedPeriod = 'PM';
        } else if (inputTime.includes('am')) {
          matchedPeriod = 'AM';
        }

        // Check if it's 24-hour format (no AM/PM specified and hour > 12)
        if (!matchedPeriod && matchedHour > 12) {
          is24HourFormat = true;
        }

        break;
      }
    }

    if (!matchedFormat) {
      // Try alternative parsing for edge cases
      const alternativePatterns = [
        // Handle formats like "6:00", "14:30" without AM/PM
        /^(\d{1,2}):(\d{2})$/,
        // Handle single digits with various separators
        /^(\d{1,2})[^\d]*$/
      ];

      for (const altPattern of alternativePatterns) {
        const match = inputTime.match(altPattern);
        if (match) {
          matchedFormat = true;
          matchedHour = parseInt(match[1]);
          if (match[2]) {
            matchedMinute = parseInt(match[2]);
          }

          // For hours > 12, assume 24-hour format
          if (matchedHour > 12) {
            is24HourFormat = true;
          }
          break;
        }
      }
    }

    if (!matchedFormat) {
      const availableTimes = userState.availableTimeSlots.map(slot =>
        dayjs(slot).format('h:mm A')
      ).join(', ');

      await new Promise(resolve => setTimeout(resolve, 5000));
      await message.reply(`Sorry, I couldn't understand that time format. Available times are: ${availableTimes}. Please try formats like "2pm", "2:00pm", "14:00", or "6:".`);
      return;
    }

    // Now try to match with available time slots
    if (is24HourFormat) {
      // Direct 24-hour format matching
      for (const timeSlot of userState.availableTimeSlots) {
        const slotTime = dayjs(timeSlot);

        if (slotTime.hour() === matchedHour && slotTime.minute() === matchedMinute) {
          selectedTime = timeSlot;
          break;
        }
      }
    } else if (matchedPeriod) {
      // AM/PM explicitly provided
      let hour24 = matchedHour;

      if (matchedPeriod === 'PM' && matchedHour < 12) {
        hour24 = matchedHour + 12;
      } else if (matchedPeriod === 'AM' && matchedHour === 12) {
        hour24 = 0;
      }

      for (const timeSlot of userState.availableTimeSlots) {
        const slotTime = dayjs(timeSlot);

        if (slotTime.hour() === hour24 && slotTime.minute() === matchedMinute) {
          selectedTime = timeSlot;
          break;
        }
      }
    } else {
      // No AM/PM specified - try to infer from available slots
      const candidateHours = [];

      // For hours 1-11, try both AM and PM
      if (matchedHour >= 1 && matchedHour <= 11) {
        candidateHours.push(matchedHour); // AM version
        candidateHours.push(matchedHour + 12); // PM version
      }
      // For hour 12, try both noon and midnight
      else if (matchedHour === 12) {
        candidateHours.push(12); // Noon (PM)
        candidateHours.push(0);  // Midnight (AM)
      }
      // For hours > 12, treat as 24-hour format
      else if (matchedHour > 12) {
        candidateHours.push(matchedHour);
      }

      // Try to find a matching slot
      for (const candidateHour of candidateHours) {
        for (const timeSlot of userState.availableTimeSlots) {
          const slotTime = dayjs(timeSlot);

          if (slotTime.hour() === candidateHour && slotTime.minute() === matchedMinute) {
            selectedTime = timeSlot;
            break;
          }
        }

        if (selectedTime) break;
      }
    }

    // If still no match, try fuzzy matching (within 15 minutes)
    if (!selectedTime) {
      const tolerance = 15; // minutes

      for (const timeSlot of userState.availableTimeSlots) {
        const slotTime = dayjs(timeSlot);

        // Try different hour interpretations
        const possibleHours = [];
        if (is24HourFormat || matchedHour > 12) {
          possibleHours.push(matchedHour);
        } else {
          if (matchedPeriod === 'PM' && matchedHour < 12) {
            possibleHours.push(matchedHour + 12);
          } else if (matchedPeriod === 'AM' && matchedHour === 12) {
            possibleHours.push(0);
          } else if (matchedPeriod === 'AM') {
            possibleHours.push(matchedHour);
          } else if (matchedPeriod === 'PM' && matchedHour === 12) {
            possibleHours.push(12);
          } else {
            // No AM/PM - try both
            possibleHours.push(matchedHour);
            if (matchedHour <= 11) possibleHours.push(matchedHour + 12);
            if (matchedHour === 12) possibleHours.push(0);
          }
        }

        for (const hour of possibleHours) {
          const targetTime = slotTime.hour(hour).minute(matchedMinute);
          const timeDiff = Math.abs(slotTime.diff(targetTime, 'minute'));

          if (timeDiff <= tolerance) {
            selectedTime = timeSlot;
            break;
          }
        }

        if (selectedTime) break;
      }
    }

    if (!selectedTime) {
      // Format the available times for the error message
      const availableTimes = userState.availableTimeSlots.map(slot =>
        dayjs(slot).format('h:mm A')
      ).join(', ');

      await new Promise(resolve => setTimeout(resolve, 5000));
      await message.reply(`Sorry, I couldn't find a matching time slot for "${messageContent}". Available times are: ${availableTimes}. 

You can try formats like:
• "2pm" or "2PM" 
• "2:00pm" or "2:00PM"
• "14:00" (24-hour format)
• "6:" or "6:pm"
• "2 pm" (with space)

Please select one of the available times.`);
      return;
    }

    // Get the current appointment
    const currentAppointment = userState.currentAppointment;

    // Update the appointment time
    const oldAppointmentTime = dayjs(currentAppointment.appointmentTime).format('dddd, MMMM D, YYYY [at] h:mm A');
    currentAppointment.appointmentTime = selectedTime;

    // Update in the main appointments array
    const appointmentIndex = appointmentData.findIndex(appt => appt.phone === phone);
    if (appointmentIndex !== -1) {
      appointmentData[appointmentIndex].appointmentTime = selectedTime;
    }

    // Save to Excel
    saveAppointmentsToExcel();

    // Send confirmation message
    const confirmationMessage = `Great! Your appointment has been rescheduled from ${oldAppointmentTime} to ${dayjs(selectedTime).format('dddd, MMMM D, YYYY [at] h:mm A')}.\n\nWe look forward to seeing you then. You will receive reminders before your appointment.`;

    // Add 5-second delay before responding
    await new Promise(resolve => setTimeout(resolve, 5000));
    await message.reply(confirmationMessage);

    // Clear the rescheduling state
    delete userReschedulingState[phone];

    console.log(`✅ Successfully rescheduled appointment for ${currentAppointment.name} to ${dayjs(selectedTime).format('YYYY-MM-DD HH:mm')}`);

  } catch (err) {
    console.error("❌ Error handling time selection:", err.message);
    await new Promise(resolve => setTimeout(resolve, 5000));
    await message.reply("Sorry, there was an error processing your time selection. Please try again later or contact our office directly.");
    delete userReschedulingState[phone]; // Clear state on error
  }
}

// New function to handle cancellation requests with engaging responses
async function handleCancellationRequest(phone, message) {
  try {
    // Find if this user has an appointment
    const userAppointment = appointmentData.find(appt => appt.phone === phone);

    if (!userAppointment) {
      await message.reply("We couldn't find any appointments associated with this number. If you need to schedule one, please contact our office directly.");
      return;
    }

    // Get the appointment details for personalized messaging
    const appointmentDate = dayjs(userAppointment.appointmentTime).format('dddd, MMMM D');
    const appointmentTime = dayjs(userAppointment.appointmentTime).format('h:mm A');

    // Generate an engaging response to discourage cancellation
    let engagingResponse;

    // If GROQ API is available, use it to generate a personalized response
    if (process.env.GROQ_API_KEY) {
      try {
        const prompt = `Write a friendly, persuasive message for ${userAppointment.name} who wants to cancel their appointment on ${appointmentDate} at ${appointmentTime}. The message should:
        1. Acknowledge their desire to cancel
        2. Highlight the benefits of keeping the appointment
        3. Offer rescheduling as an alternative to cancellation
        4. Use warm, conversational language
        5. Be brief (under 150 words) but compelling
        6. End with clear options for next steps (confirm cancellation or reschedule)`;

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

        engagingResponse = response.data.choices[0].message.content.trim();
      } catch (error) {
        console.error("❌ Error generating cancellation response:", error);
        // Fall back to template if API fails
        engagingResponse = getDefaultCancellationMessage(userAppointment.name, appointmentDate, appointmentTime);
      }
    } else {
      // Use default template if no API key
      engagingResponse = getDefaultCancellationMessage(userAppointment.name, appointmentDate, appointmentTime);
    }

    // Add action buttons as text options at the end
    engagingResponse += "\n\n✅ To confirm cancellation, reply with \"CONFIRM CANCEL\"\n📅 To reschedule instead, reply with \"RESCHEDULE\"";

    // Set up a cancellation state for this user
    userReschedulingState[phone] = {
      currentAppointment: userAppointment,
      stage: 'confirming_cancellation'
    };

    // Send the engaging response
    await message.reply(engagingResponse);

  } catch (err) {
    console.error("❌ Error handling cancellation request:", err.message);
    await message.reply("Sorry, there was an error processing your request. Please call our office directly for assistance with your appointment.");
  }
}

// Default cancellation response template with fancy messaging
function getDefaultCancellationMessage(name, date, time) {
  return `✨ *Hi ${name}!* ✨\n\nI see you'd like to cancel your appointment for *${date}* at *${time}*.\n\nBefore we proceed with cancellation, I wanted to mention that this time slot was reserved specially for you, and our team has been preparing for your visit!\n\nLife gets busy, and sometimes rescheduling works better than cancelling. We have several convenient alternatives available that might better fit your schedule.`;
}

// Process the actual cancellation
async function processCancellation(phone, message) {
  try {
    const userAppointment = userReschedulingState[phone].currentAppointment;

    // Remove from appointment data array
    const appointmentIndex = appointmentData.findIndex(appt => appt.phone === phone);
    if (appointmentIndex !== -1) {
      appointmentData.splice(appointmentIndex, 1);

      // Save updated list to Excel
      saveAppointmentsToExcel();

      // Generate a farewell message
      let farewellMessage;
      if (process.env.GROQ_API_KEY) {
        try {
          const prompt = `Write a brief, friendly message confirming that ${userAppointment.name}'s appointment has been cancelled. Express appreciation for their communication, note that they're welcome to schedule again in the future, and keep it under 100 words.`;

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

          farewellMessage = response.data.choices[0].message.content.trim();
        } catch (error) {
          console.error("❌ Error generating farewell message:", error);
          farewellMessage = `Your appointment has been cancelled, ${userAppointment.name}. Thank you for letting us know. We hope to see you again soon!`;
        }
      } else {
        farewellMessage = `Your appointment has been cancelled, ${userAppointment.name}. Thank you for letting us know. We hope to see you again soon!`;
      }

      // Send confirmation message
      await message.reply(farewellMessage);

      // Optional: Could also notify staff about the cancellation here

      // Clear the user state
      delete userReschedulingState[phone];
    } else {
      await message.reply("We couldn't find your appointment in our system. Please contact our office directly for assistance.");
    }
  } catch (err) {
    console.error("❌ Error processing cancellation:", err.message);
    await message.reply("Sorry, there was an error cancelling your appointment. Please call our office directly for assistance.");
    delete userReschedulingState[phone]; // Clear state on error
  }
}

// Get available dates for rescheduling (next X days that are within business hours)
function getAvailableDates(numDays) {
  const availableDates = [];
  const now = dayjs();

  // Look at the next [numDays] days
  for (let i = 1; i <= numDays; i++) {
    const date = now.add(i, 'day');
    const dayOfWeek = date.day(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

    // Check if this day has business hours
    if (BUSINESS_HOURS[dayOfWeek] && BUSINESS_HOURS[dayOfWeek].open) {
      availableDates.push(date.format('YYYY-MM-DD'));
    }
  }

  return availableDates;
}

// Get available time slots for a given date, avoiding overlaps with existing appointments
function getAvailableTimeSlots(dateStr, userPhone) {
  const date = dayjs(dateStr);
  const dayOfWeek = date.day(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const availableSlots = [];

  // Check if this day has business hours
  if (!BUSINESS_HOURS[dayOfWeek] || !BUSINESS_HOURS[dayOfWeek].open) {
    return []; // No business hours for this day
  }

  // Parse business hours
  const [openHour, openMinute] = BUSINESS_HOURS[dayOfWeek].open.split(':').map(Number);
  const [closeHour, closeMinute] = BUSINESS_HOURS[dayOfWeek].close.split(':').map(Number);

  // Generate all possible time slots based on business hours
  let currentSlot = date.hour(openHour).minute(openMinute).second(0);
  const endTime = date.hour(closeHour).minute(closeMinute).second(0);

  while (currentSlot.isBefore(endTime)) {
    // Check if this slot overlaps with any existing appointment
    if (isTimeSlotAvailable(currentSlot.toISOString(), userPhone)) {
      availableSlots.push(currentSlot.toISOString());
    }

    // Move to next slot
    currentSlot = currentSlot.add(TIME_SLOT_DURATION, 'minute');
  }

  return availableSlots;
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

function saveStatusDataToFile() {
  try {
    fs.writeFileSync(STATUS_FILE_PATH, JSON.stringify(statusSheetData, null, 2));
    console.log(`✅ Status data saved to ${STATUS_FILE_PATH}`);
  } catch (err) {
    console.error("❌ Error saving status data:", err.message);
  }
}

function loadStatusDataFromFile() {
  try {
    if (fs.existsSync(STATUS_FILE_PATH)) {
      const data = fs.readFileSync(STATUS_FILE_PATH, 'utf-8');
      statusSheetData = JSON.parse(data);
      console.log(`✅ Loaded ${statusSheetData.length} status records from ${STATUS_FILE_PATH}`);
    } else {
      console.log("📋 No existing status data file found");
    }
  } catch (err) {
    console.error("❌ Error loading status data:", err.message);
  }
}

function loadSeenAppointments() {
  try {
    if (fs.existsSync(SEEN_APPOINTMENTS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_APPOINTMENTS_FILE, 'utf-8')));
    }
  } catch (err) {
    console.error("❌ Error loading seen appointments:", err.message);
  }
  return new Set();
}

function saveSeenAppointments(phoneSet) {
  try {
    fs.writeFileSync(SEEN_APPOINTMENTS_FILE, JSON.stringify([...phoneSet], null, 2));
  } catch (err) {
    console.error("❌ Error saving seen appointments:", err.message);
  }
}


// Send hook messages to "NO" status people when new appointments are added
async function sendHookMessagesToNoStatusPeople(newAppointments) {
  if (!statusSheetData.length || !whatsappClient || !app.locals.whatsappConnected) {
    return;
  }

  try {
    // Get people with "NO" status
    const noStatusPeople = statusSheetData.filter(person => person.status === 'no');
    console.log("✅ Found 'no' status people:", noStatusPeople);


    if (noStatusPeople.length === 0) {
      console.log("No people with 'NO' status found to send hook messages");
      return;
    }

    // Send message to each "NO" status person for each new appointment
    for (const newAppointment of newAppointments) {
      noStatusPeople.forEach((noStatusPerson, index) => {
        const delayMs = index * 5 * 60 * 1000;
        // 5 minutes per person
        console.log(`⏳ Scheduling message to ${noStatusPerson.name} (${noStatusPerson.phone}) in ${delayMs / 1000} seconds`);

        setTimeout(async () => {
          console.log(`📤 Time to send message to ${noStatusPerson.name}`);
          try {
            let hookMessage;

            if (process.env.GROQ_API_KEY) {
              try {
                const prompt = `Write a friendly WhatsApp message to ${noStatusPerson.name} telling them that ${newAppointment.name} has joined our team/service and asking what they're waiting for to book an appointment with us. Keep it engaging, under 100 words, and include a call-to-action to book an appointment.`;

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

                hookMessage = response.data.choices[0].message.content.trim();
              } catch (error) {
                console.error("❌ Error generating hook message:", error);
                hookMessage = `Hi ${noStatusPerson.name}! 🎉 ${newAppointment.name} has just joined our team! What are you waiting for? Book your appointment with us now!`;
              }
            } else {
              hookMessage = `Hi ${noStatusPerson.name}! 🎉 ${newAppointment.name} has just joined our team! What are you waiting for? Book your appointment with us now!`;
            }

            await sendWhatsAppMessage(`${noStatusPerson.phone}@c.us`, hookMessage);
            console.log(`✅ Sent hook message to ${noStatusPerson.name} after ${delayMs / 60000} minutes`);
          } catch (error) {
            console.error(`❌ Error sending hook message to ${noStatusPerson.name}:`, error.message);
          }
        }, delayMs); // Schedule each message based on index
      });
    }


  } catch (error) {
    console.error("❌ Error in sendHookMessagesToNoStatusPeople:", error.message);
  }
}

// Serve the home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle Excel file upload - WITH FIXED PHONE NUMBER HANDLING
// Handle Excel file upload - FIXED TO PRESERVE RESCHEDULED APPOINTMENTS
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

    // Validate and format the new data from uploaded file
    const newAppointments = rawData.filter(row =>
      row.name && row.phone && row.appointmentTime
    ).map(row => {
      // Handle phone number - improved scientific notation handling
      let phoneStr;
      if (typeof row.phone === 'number') {
        // Convert to full number without scientific notation
        phoneStr = row.phone.toLocaleString('fullwide', { useGrouping: false });
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
        appointmentTime: appointmentDateTime,
        isFromUpload: true // Mark as coming from upload
      };
    });

    if (newAppointments.length === 0) {
      return res.status(400).json({
        error: "Excel file must contain columns: name, phone, appointmentTime"
      });
    }

    // SMART MERGE: Preserve existing rescheduled appointments
    const mergedAppointments = [];
    const processedPhones = new Set();

    // First, add all existing appointments that have been modified (rescheduled)
    // These are appointments that exist in memory but may have different times than the uploaded file
    for (const existingAppt of appointmentData) {
      // Check if this phone number exists in the new upload
      const matchingNewAppt = newAppointments.find(newAppt => newAppt.phone === existingAppt.phone);

      if (matchingNewAppt) {
        // Compare appointment times to see if it was rescheduled
        const existingTime = dayjs(existingAppt.appointmentTime);
        const newTime = dayjs(matchingNewAppt.appointmentTime);

        if (!existingTime.isSame(newTime)) {
          // Times are different - this appointment was rescheduled, keep the existing (rescheduled) version
          console.log(`📅 Preserving rescheduled appointment for ${existingAppt.name} (${existingAppt.phone})`);
          mergedAppointments.push({
            ...existingAppt,
            isRescheduled: true
          });
          processedPhones.add(existingAppt.phone);
        }
      } else {
        // This appointment exists in memory but not in the new upload
        // It might be a new appointment that was added through rescheduling, so keep it
        console.log(`📅 Preserving existing appointment for ${existingAppt.name} (${existingAppt.phone}) - not in new upload`);
        mergedAppointments.push({
          ...existingAppt,
          isExisting: true
        });
        processedPhones.add(existingAppt.phone);
      }
    }

    // Then, add new appointments that haven't been processed yet
    const seenPhones = loadSeenAppointments();
    const newlySeenPhones = new Set(seenPhones); // Clone

    const trulyNewAppointments = [];

    for (const newAppt of newAppointments) {
      if (!processedPhones.has(newAppt.phone)) {
        mergedAppointments.push(newAppt);
        processedPhones.add(newAppt.phone);

        if (!seenPhones.has(newAppt.phone)) {
          trulyNewAppointments.push(newAppt);
          newlySeenPhones.add(newAppt.phone);
        }
      }
    }

    saveSeenAppointments(newlySeenPhones);


    // Update the appointment data with merged results
    appointmentData = mergedAppointments;

    // Save the merged appointments to Excel (this will include rescheduled times)
    saveAppointmentsToExcel();

    // Format dates for display in frontend
    const formattedAppointments = mergedAppointments.map(appointment => ({
      name: appointment.name,
      phone: appointment.phone,
      appointmentTime: dayjs(appointment.appointmentTime).format('YYYY-MM-DD HH:mm'),
      status: appointment.isRescheduled ? 'Rescheduled' :
        appointment.isExisting ? 'Existing' : 'New'
    }));

    // Clean up the uploaded file
    fs.unlinkSync(req.file.path);

    // Restart reminder loop with merged data
    // Restart reminder loop with merged data
    startReminderLoop();

    // Send hook messages to "NO" status people about new appointments
    if (trulyNewAppointments.length > 0) {
      console.log(`📢 Sending hook messages for ${trulyNewAppointments.length} new appointments`);
      // Send hook messages asynchronously to avoid blocking the response
      setTimeout(() => {
        sendHookMessagesToNoStatusPeople(trulyNewAppointments);
      }, 5000); // 5-second delay to ensure everything is ready
    }

    // Count different types of appointments
    const rescheduledCount = mergedAppointments.filter(a => a.isRescheduled).length;
    const existingCount = mergedAppointments.filter(a => a.isExisting).length;
    const newCount = mergedAppointments.filter(a => a.isFromUpload && !a.isRescheduled && !a.isExisting).length;

    let statusMessage = `Successfully processed ${mergedAppointments.length} total appointments`;
    if (rescheduledCount > 0) statusMessage += ` (${rescheduledCount} rescheduled preserved)`;
    if (existingCount > 0) statusMessage += ` (${existingCount} existing preserved)`;
    if (newCount > 0) statusMessage += ` (${newCount} new from upload)`;

    return res.json({
      success: true,
      message: statusMessage,
      appointments: formattedAppointments,
      whatsappStatus: app.locals.whatsappConnected ? "connected" : "disconnected",
      stats: {
        total: mergedAppointments.length,
        rescheduled: rescheduledCount,
        existing: existingCount,
        new: newCount
      }
    });
  } catch (error) {
    console.error("❌ Error processing Excel file:", error);
    return res.status(500).json({ error: "Failed to process Excel file: " + error.message });
  }
});

// Handle second Excel file upload (status sheet)
app.post("/upload-status", upload.single("statusFile"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    // Read the Excel file
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON with raw values
    const rawData = XLSX.utils.sheet_to_json(worksheet, {
      raw: true
    });

    // Validate and format the status data
    const statusData = rawData.filter(row =>
      row.name && row.phone && row.status
    ).map(row => {
      // Handle phone number - same logic as first sheet
      let phoneStr;
      if (typeof row.phone === 'number') {
        phoneStr = row.phone.toLocaleString('fullwide', { useGrouping: false });
      } else {
        phoneStr = row.phone.toString();
      }

      // Clean phone number (remove any non-digit characters)
      phoneStr = phoneStr.replace(/[^\d]/g, "");

      return {
        name: row.name,
        phone: phoneStr,
        status: row.status.toString().toLowerCase() // Normalize to lowercase
      };
    });

    if (statusData.length === 0) {
      return res.status(400).json({
        error: "Excel file must contain columns: name, phone, status"
      });
    }

    // Store the status data globally (you'll need to add this variable)
    // Avoid re-adding duplicates
    const existingPhones = new Set(statusSheetData.map(item => item.phone));
    const newStatusEntries = statusData.filter(item => !existingPhones.has(item.phone));

    if (newStatusEntries.length > 0) {
      statusSheetData.push(...newStatusEntries);
      saveStatusDataToFile(); // Save merged data
      console.log(`✅ Added ${newStatusEntries.length} new status entries`);
    } else {
      console.log("📋 No new status entries to add");
    }


    // Clean up the uploaded file
    fs.unlinkSync(req.file.path);

    // Format data for display in frontend
    const formattedStatusData = statusData.map(item => ({
      name: item.name,
      phone: item.phone,
      status: item.status
    }));

    return res.json({
      success: true,
      message: `Successfully processed ${statusData.length} status records`,
      statusData: formattedStatusData,
      stats: {
        total: statusData.length,
        yes: statusData.filter(item => item.status === 'yes').length,
        no: statusData.filter(item => item.status === 'no').length
      }
    });

  } catch (error) {
    console.error("❌ Error processing status Excel file:", error);
    return res.status(500).json({ error: "Failed to process status Excel file: " + error.message });
  }
});

// Clear appointment memory
app.post("/clear-appointments", (req, res) => {
  appointmentData = [];
  saveAppointmentsToExcel(); // Clears file too
  console.log("🧹 All appointment data cleared");
  return res.json({ success: true, message: "All appointment data has been cleared." });
});

// Clear status memory
app.post("/clear-status", (req, res) => {
  statusSheetData = [];
  saveStatusDataToFile(); // Clears JSON file
  console.log("🧹 All status data cleared");
  return res.json({ success: true, message: "All status data has been cleared." });
});


// Get current status data
app.get("/status-data", (req, res) => {
  return res.json({
    success: true,
    statusData: statusSheetData,
    count: statusSheetData.length
  });
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
    return `Hi ${name}, this is a reminder that your appointment is scheduled for today at ${dayjs(apptTimeStr).format("h:mm A")}. We look forward to seeing you soon!`;
  }

  try {
    const prompt = `Write a friendly WhatsApp reminder for ${name} that their appointment is scheduled at ${dayjs(apptTimeStr).format("h:mm A")} TODAY, just 5 hours from now. Keep it short and clear.`;
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
    return `Hi ${name}, this is a reminder that your appointment is scheduled for today at ${dayjs(apptTimeStr).format("h:mm A")}. We look forward to seeing you soon!`;
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  console.log(`➡️ Trying to send message to ${to}`);
  try {
    await whatsappClient.sendMessage(to, message);
    console.log(`✅ Reminder sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send to ${to}:`, err.message);
    return false;
  }
}


function loadExistingAppointments() {
  try {
    if (!fs.existsSync(EXCEL_FILE_PATH)) {
      console.log("📋 No existing appointments file found");
      return;
    }

    // Read the existing Excel file
    const workbook = XLSX.readFile(EXCEL_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const rawData = XLSX.utils.sheet_to_json(worksheet, { raw: true });

    // Format the data
    const validData = rawData.filter(row =>
      row.name && row.phone && row.appointmentTime
    ).map(row => {
      // Handle phone number
      let phoneStr;
      if (typeof row.phone === 'number') {
        phoneStr = row.phone.toLocaleString('fullwide', { useGrouping: false });
      } else {
        phoneStr = row.phone.toString();
      }
      phoneStr = phoneStr.replace(/[^\d]/g, "");

      // Handle appointment time
      let appointmentDateTime;
      if (typeof row.appointmentTime === 'string') {
        appointmentDateTime = dayjs(row.appointmentTime).toISOString();
      } else {
        appointmentDateTime = new Date(row.appointmentTime).toISOString();
      }

      return {
        name: row.name,
        phone: phoneStr,
        appointmentTime: appointmentDateTime
      };
    });

    appointmentData = validData;
    console.log(`✅ Loaded ${validData.length} existing appointments from ${EXCEL_FILE_PATH}`);

  } catch (error) {
    console.error("❌ Error loading existing appointments:", error.message);
  }
}

initializeWhatsAppClient();

// Load existing appointments before starting server
loadExistingAppointments();
loadStatusDataFromFile();

// Start the Express server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});