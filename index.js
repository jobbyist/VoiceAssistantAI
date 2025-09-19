import dotenv from 'dotenv';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { z } from 'zod';
import nodemailer from 'nodemailer';
+ import twilio from 'twilio';
import Stripe from 'stripe';
// Import OpenAI realtime agent classes and Twilio transport layer.  These packages
// are not bundled with this repository by default – see package.json for
// dependencies and install them locally via `npm install`.
// correct
import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { tool } from '@openai/agents';
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions';

// Load environment variables from the `.env` file.  See `.env.example` for the
// variables required to run this application.
dotenv.config();

// Destructure the configuration from process.env.  These environment
// variables can be supplied via a `.env` file or directly in the execution
// environment (e.g. on Vercel).  For security, never commit secrets to
// version control.
const {
  PORT,
  OPENAI_API_KEY,
  LAW_FIRM_EMAIL,
  ESCALATION_EMAIL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  HUMAN_PHONE_NUMBER,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  // Calendly configuration
  CALENDLY_PERSONAL_ACCESS_TOKEN,
  CALENDLY_FREE_PHONE_LINK,
  CALENDLY_FREE_ZOOM_LINK,
  CALENDLY_PAID_ZOOM_LINK,
  CALENDLY_PAID_IN_PERSON_LINK,
  // Stripe configuration
  STRIPE_SECRET_KEY,
  STRIPE_PRICE_ID_60_MIN,
} = process.env;

// Basic sanity check for the API key.  If the OPENAI_API_KEY is missing the
// server will exit immediately instead of attempting to handle calls.
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable.');
  process.exit(1);
}

// Configure an SMTP transporter using nodemailer.  The SMTP credentials
// determine where the call transcripts and tool outputs are delivered.  Use a
// dedicated mailbox for outgoing mail (e.g. SendGrid, Gmail, or another
// provider).  If your provider requires TLS, set `secure: true` and
// configure the appropriate port (usually 465).
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT ? parseInt(SMTP_PORT) : 587,
  secure: false,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

// Optional Twilio client used to perform outbound calls when handing off to a
// human.  This requires an Account SID, Auth Token and the Twilio phone
// number you wish to originate calls from.  If any of these variables are
// missing the client will not be configured and escalation will be limited to
// email notifications.
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
   // twilio CJS default export is a factory function: client = twilio(sid, token)
twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

// Optional Stripe client used to generate payment links for paid consultations.
// The Stripe secret key and price ID must be provided via environment
// variables.  When configured, the `book_consultation` tool will create
// checkout links for the $500 consultation.
let stripeClient = null;
if (STRIPE_SECRET_KEY) {
  stripeClient = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });
}

/*
 * Tool definitions
 *
 * The OpenAI Agents SDK supports tool calling via structured function
 * definitions.  Each tool is declared with a name, description, parameter
 * schema using zod and an async execute function.  When the model
 * determines a tool call is appropriate it will call the execute function
 * with validated inputs.
 */

// Schedule an appointment with the legal team.  In this example the tool
// sends an email to the law firm’s inbox summarising the client’s request.
const scheduleAppointmentTool = tool({
  name: 'schedule_appointment',
  description: 'Schedule a consultation appointment for a client.',
  parameters: z.object({
    date: z
      .string()
      .describe('Desired appointment date in YYYY-MM-DD format.'),
    time: z
      .string()
      .describe('Desired appointment time (e.g. "15:00" or "3pm").'),
    clientName: z
      .string()
      .describe('Name of the client requesting the appointment.'),
  }),
  execute: async ({ date, time, clientName }) => {
    const subject = `Appointment request from ${clientName}`;
    const body = `Client ${clientName} has requested an appointment on ${date} at ${time}.`;
    if (LAW_FIRM_EMAIL) {
      await transporter.sendMail({
        from: SMTP_USER,
        to: LAW_FIRM_EMAIL,
        subject,
        text: body,
      });
    }
    return `Your appointment request for ${date} at ${time} has been recorded. Our team will follow up to confirm availability.`;
  },
});

/*
 * Book a consultation with the legal team.  Callers may choose between a
 * free 15‑minute consultation (over the phone or via Zoom) or a paid
 * one‑hour consultation (Zoom or in person) for $500.  When called, this
 * tool sends confirmation emails to both the client and the firm, creates a
 * Calendly scheduling link, and optionally generates a Stripe checkout
 * session for paid consultations.  The law firm can configure the
 * appropriate Calendly event links and Stripe price IDs via environment
 * variables.
 */
const bookConsultationTool = tool({
  name: 'book_consultation',
  description:
    'Book a consultation for the caller.  Clients can choose a free 15‑minute call (phone or Zoom) or a 1‑hour session (Zoom or in person) that costs $500.',
  parameters: z.object({
    consultationType: z
      .enum([
        'free_phone',
        'free_zoom',
        'paid_zoom',
        'paid_in_person',
      ])
      .describe(
        'Type of consultation requested: "free_phone" for a 15‑minute phone call, "free_zoom" for a 15‑minute Zoom call, "paid_zoom" for a 1‑hour Zoom consultation, or "paid_in_person" for a 1‑hour in‑person meeting.  Paid options cost $500.'
      ),
    date: z.string().describe('Preferred appointment date in YYYY‑MM‑DD format.'),
    time: z.string().describe('Preferred appointment time (e.g. "15:00" or "3pm").'),
    clientName: z
      .string()
      .describe('Full name of the client scheduling the consultation.'),
    clientPhone: z
      .string()
      .describe('Best phone number for reaching the client.'),
    clientEmail: z
      .string()
      .describe('Client email address for sending confirmation and payment links.'),
  }),
  execute: async ({
    consultationType,
    date,
    time,
    clientName,
    clientPhone,
    clientEmail,
  }) => {
    // Determine the appropriate Calendly link for the requested consultation
    let calendlyLink;
    let paid = false;
    switch (consultationType) {
      case 'free_phone':
        calendlyLink = CALENDLY_FREE_PHONE_LINK;
        break;
      case 'free_zoom':
        calendlyLink = CALENDLY_FREE_ZOOM_LINK;
        break;
      case 'paid_zoom':
        calendlyLink = CALENDLY_PAID_ZOOM_LINK;
        paid = true;
        break;
      case 'paid_in_person':
        calendlyLink = CALENDLY_PAID_IN_PERSON_LINK;
        paid = true;
        break;
      default:
        calendlyLink = CALENDLY_FREE_PHONE_LINK;
    }
    let paymentUrl = null;
    if (paid && stripeClient && STRIPE_PRICE_ID_60_MIN) {
      try {
        // Create a Stripe Payment Link for the 1‑hour paid consultation.
        const link = await stripeClient.paymentLinks.create({
          line_items: [
            {
              price: STRIPE_PRICE_ID_60_MIN,
              quantity: 1,
            },
          ],
          metadata: {
            client_name: clientName,
            client_email: clientEmail,
          },
        });
        paymentUrl = link.url;
      } catch (error) {
        console.error('Error creating Stripe payment link:', error);
      }
    }
    // Construct the consultation description
    const consultationDescription =
      consultationType === 'free_phone'
        ? 'a free 15‑minute phone consultation'
        : consultationType === 'free_zoom'
        ? 'a free 15‑minute Zoom consultation'
        : consultationType === 'paid_zoom'
        ? 'a paid 1‑hour Zoom consultation'
        : 'a paid 1‑hour in‑person consultation';
    // Build email for the client
    const emailSubject = `Your consultation request with Pritpal Singh Law`;
    let emailBody = `Hello ${clientName},\n\nThank you for choosing the Law Offices of Pritpal Singh for your real‑estate matter. You have requested ${consultationDescription} on ${date} at ${time}.\n\n`;
    if (calendlyLink) {
      emailBody += `To confirm your appointment, please use the following link to select a time on our calendar: ${calendlyLink}\n\n`;
    }
    if (paymentUrl) {
      emailBody += `This consultation requires payment. Please use the following secure link to complete your $500 payment: ${paymentUrl}\n\n`;
    }
    emailBody += `If you have any questions or need to adjust your appointment, please reply to this email or call our office.\n\nWe look forward to speaking with you.\n\nBest regards,\nThe Law Offices of Pritpal Singh`;
    // Send confirmation email to the client
    try {
      await transporter.sendMail({
        from: SMTP_USER,
        to: clientEmail,
        subject: emailSubject,
        text: emailBody,
      });
    } catch (error) {
      console.error('Error sending consultation confirmation email:', error);
    }
    // Notify the law firm of the booking request
    const internalSubject = `New consultation request from ${clientName}`;
    let internalBody = `Client Name: ${clientName}\nPhone: ${clientPhone}\nEmail: ${clientEmail}\nRequested Type: ${consultationDescription}\nPreferred Date: ${date}\nPreferred Time: ${time}\n`;
    if (paymentUrl) {
      internalBody += `Payment link: ${paymentUrl}\n`;
    }
    if (calendlyLink) {
      internalBody += `Calendly link: ${calendlyLink}\n`;
    }
    if (LAW_FIRM_EMAIL) {
      try {
        await transporter.sendMail({
          from: SMTP_USER,
          to: LAW_FIRM_EMAIL,
          subject: internalSubject,
          text: internalBody,
        });
      } catch (error) {
        console.error('Error sending internal consultation notification:', error);
      }
    }
    return `Thank you, ${clientName}. I’ve recorded your request for ${consultationDescription} on ${date} at ${time}. A confirmation has been sent to your email${paymentUrl ? ' with a payment link' : ''}.`;
  },
});

// Process a payment for legal services.  This tool demonstrates how you might
// integrate with a payment gateway.  In this sample the payment details are
// emailed to the law firm’s billing department; no real payment is taken.
const processPaymentTool = tool({
  name: 'process_payment',
  description:
    'Process a client’s payment for legal fees. Use USD amounts and describe the payment method (e.g. credit card).',
  parameters: z.object({
    amount: z
      .number()
      .describe('Amount to charge in US dollars.'),
    clientName: z
      .string()
      .describe('Name of the client making the payment.'),
    paymentMethod: z
      .string()
      .describe('Method of payment (e.g. "Visa", "Mastercard", "bank transfer").'),
  }),
  execute: async ({ amount, clientName, paymentMethod }) => {
    const subject = `Payment received from ${clientName}`;
    const body = `A payment of $${amount} has been initiated via ${paymentMethod} for client ${clientName}. Please process this payment according to your billing procedures.`;
    if (LAW_FIRM_EMAIL) {
      await transporter.sendMail({
        from: SMTP_USER,
        to: LAW_FIRM_EMAIL,
        subject,
        text: body,
      });
    }
    return `Thank you, ${clientName}. A payment of $${amount} via ${paymentMethod} has been recorded. A receipt will be sent shortly.`;
  },
});

// Escalate a call to a human legal assistant.  If a TWILIO client is
// configured the tool will initiate an outbound phone call to connect the
// caller with a designated human.  Regardless, an email is sent to the
// law firm detailing the reason for the escalation.
const escalatetoHumanTool = tool({
  name: 'escalate_to_human',
  description:
    'Escalate the conversation to a human when the caller’s request requires legal advice or specialised assistance.  Collect contact details and preferred follow‑up information before handing off.',
  parameters: z.object({
    reason: z
      .string()
      .describe('Reason for requesting human assistance.'),
    clientName: z
      .string()
      .describe('Full name of the caller requesting escalation.'),
    clientPhone: z
      .string()
      .describe('Best phone number for reaching the caller.'),
    clientEmail: z
      .string()
      .describe('Email address for the caller.'),
    preferredContactDay: z
      .string()
      .describe('Preferred day of the week for a follow‑up call (e.g. "Monday" or "any day").'),
    preferredContactTime: z
      .string()
      .describe('Preferred time of day for follow‑up (e.g. "morning", "afternoon", "3pm").'),
    preferredContactMedium: z
      .enum(['phone', 'email'])
      .describe('Preferred method to reach the caller (phone or email).'),
  }),
  execute: async ({
    reason,
    clientName,
    clientPhone,
    clientEmail,
    preferredContactDay,
    preferredContactTime,
    preferredContactMedium,
  }) => {
    // Compose escalation details
    const subject = `Escalation request from ${clientName}`;
    const body = `A caller has requested human assistance for the following reason: ${reason}.\n\nCaller Details:\nName: ${clientName}\nPhone: ${clientPhone}\nEmail: ${clientEmail}\nPreferred contact day: ${preferredContactDay}\nPreferred contact time: ${preferredContactTime}\nPreferred contact medium: ${preferredContactMedium}\n\nPlease follow up with the client as soon as possible.`;
    const recipient = ESCALATION_EMAIL || LAW_FIRM_EMAIL;
    if (recipient) {
      try {
        await transporter.sendMail({
          from: SMTP_USER,
          to: recipient,
          subject,
          text: body,
        });
      } catch (error) {
        console.error('Error sending escalation email:', error);
      }
    }
    // Optionally dial a human representative using Twilio
    if (twilioClient && TWILIO_FROM_NUMBER && HUMAN_PHONE_NUMBER) {
      try {
        await twilioClient.calls.create({
          from: TWILIO_FROM_NUMBER,
          to: HUMAN_PHONE_NUMBER,
          url: `https://handler.twilio.com/twiml/EHXXXXXXXXXXXXXXXXXXXXXXXXXXXX`,
        });
      } catch (error) {
        console.error('Error placing outbound call for escalation:', error);
      }
    }
    return 'Thank you. I will have someone from our team follow up with you soon.';
  },
});

/*
 * Create the realtime agent.  The instructions define the assistant’s
 * personality and behaviours.  They emphasise that the assistant is
 * informative but not a lawyer, so it should not provide legal advice.  The
 * tools array enables the model to perform structured actions such as
 * scheduling, billing and escalation when appropriate.
 */
const agent = new RealtimeAgent({
  name: 'Pritpal Singh Law AI Assistant',
  instructions: `
You are an AI voice assistant for the Law Offices of Pritpal Singh.  Your role is to greet callers, collect minimal information necessary to assist them, provide concise and neutral information about California real‑estate law, offer to book consultations, process payments for paid consultations, and hand off to a human when needed.  Follow these guidelines:

• **Tone and persona:** Maintain a warm, professional and concise tone. Pronounce “Pritpal Singh” as “Prit‑pall Sing.” Speak plainly and avoid legal jargon unless the caller uses it first. Always include the disclaimer “This conversation does not create an attorney‑client relationship and is for informational purposes only.”【213820349183228†L29-L38】【213820349183228†L321-L324】
• **Language support:** Detect the caller’s language (English, Spanish or Mandarin) and respond in the same language. Translate your responses if necessary and be mindful of cultural politeness.  If you are unsure which language the caller is using, politely ask them to continue in English, Spanish, or Mandarin.
• **Practice areas:** You can answer general questions about California real‑estate law, including landlord/tenant matters, premises liability, boundary disputes, quiet title actions, adverse possession, easements and encroachments, mortgage fraud, foreclosure defense, contract drafting and review, purchase agreements, closings, broker disputes, financing documents and title and escrow issues【213820349183228†L42-L139】.  Summarise the service: “We assist with [Short Name] in several ways, including [Key Talking Points]”【213820349183228†L158-L169】.  Provide neutral information drawn from the firm’s website and the training script, but never offer definitive legal advice【213820349183228†L36-L38】.
• **Appointment booking:** If the caller wishes to schedule a consultation, offer the choice of a **free 15‑minute consultation** (by phone or via Zoom) or a **paid 1‑hour consultation** (via Zoom or in person) that costs $500.  Use the 'book_consultation' tool to collect the caller’s full name, phone number, email address, preferred date and time, and consultation type.  For paid consultations, inform the caller that a secure payment link will be sent via email and that payment is required to confirm the booking.  Confirm the caller’s details before invoking the tool and reassure them that their information will only be used for scheduling purposes【213820349183228†L216-L239】.
• **Payments:** When a caller asks to pay an outstanding legal fee or deposit, use the 'process_payment' tool.  Record the amount, the caller’s name and the payment method (e.g. Visa, Mastercard, bank transfer).  Acknowledge the payment politely and confirm that a receipt will be sent shortly.
• **Escalation:** If the caller requests legal advice, insists on speaking with an attorney immediately, has an emergency (such as a sale occurring soon), or presents a complex multi‑practice matter, use the 'escalate_to_human' tool【213820349183228†L239-L244】.  Before escalating, collect the caller’s name, phone number, email, preferred day and time to be contacted, and whether they prefer a call or an email.  Explain that a human will follow up as soon as possible.
• **Data privacy:** Only collect information necessary to schedule or triage the matter.  If the caller asks why details are needed, explain that the firm collects only what is necessary to book the consultation and that their data will not be shared outside the firm without consent【213820349183228†L225-L228】.  Always confirm personal details back to the caller before ending the call【213820349183228†L39-L40】.
• **Call closure:** At the end of the conversation, thank the caller for contacting the Law Offices of Pritpal Singh and wish them a good day.  Include the disclaimer if it has not been stated yet.  Do not exceed the scope of informational assistance.
`,
  tools: [bookConsultationTool, scheduleAppointmentTool, processPaymentTool, escalatetoHumanTool],
});

/*
 * Transcript management
 *
 * We accumulate conversational turns into a single string which is emailed to
 * the law firm once the WebSocket connection closes.  Each entry is
 * prefixed with the role or item type for clarity.
 */
function createTranscriptManager() {
  const buffer = [];
  return {
    add(entry) {
      buffer.push(entry);
    },
    get() {
      return buffer.join('\n');
    },
    isEmpty() {
      return buffer.length === 0;
    },
  };
}

// Initialise the Fastify server and register plugins for form parsing and
// WebSocket support.  Fastify is chosen for its low overhead and built-in
// WebSocket integration.
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Greeting that plays when the call is first answered.  Using an Amazon Polly
// neural voice via Twilio provides a natural-sounding greeting.
// Greeting that plays when the call is first answered.  This wording follows
// the training script: it states the firm name, identifies the virtual
// receptionist, and invites the caller to describe their real‑estate matter.
const WELCOME_GREETING =
  'LAW OFFICES OF PRITPAL SINGH—this is the virtual receptionist. How can I assist you with your California real‑estate matter today?';

// Webhook invoked by Twilio when an incoming call is received.  Respond with
// TwiML to greet the caller and initiate a media stream over WebSocket.  The
// WebSocket endpoint must be publicly accessible (e.g. via ngrok) for Twilio
// to connect.
fastify.all('/incoming-call', async (request, reply) => {
  const host = request.headers.host;
  const response = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say voice="Polly.Joanna-Neural">${WELCOME_GREETING}</Say>\n  <Connect>\n    <Stream url="wss://${host}/media-stream" />\n  </Connect>\n</Response>`;
  reply.type('text/xml').send(response);
});

// WebSocket handler for Twilio media streams.  When Twilio connects to this
// endpoint the server will establish a realtime session with OpenAI and
// forward audio to and from the model.  Conversation history is captured
// via history events for later email.
fastify.get('/media-stream', { websocket: true }, async (connection) => {
  // Create a new transcript manager per connection
  const transcriptManager = createTranscriptManager();
  try {
    // Establish the transport layer bridging the Twilio media stream and the
    // OpenAI realtime session.
    const transport = new TwilioRealtimeTransportLayer({
      twilioWebSocket: connection,
    });
    const session = new RealtimeSession(agent, {
      transport,
    });
    // Start streaming events.  This asynchronous generator yields events such
    // as history updates, tool calls and handoffs.  Use a for-await loop to
    // handle them as they arrive.
    (async () => {
      for await (const event of session.stream()) {
        if (event.type === 'history_added') {
          const { item } = event;
          // Determine how to extract text from different item types
          let roleLabel = '';
          let text = '';
          if (item.role) {
            roleLabel = item.role;
          } else if (item.type) {
            roleLabel = item.type;
          }
          if (item.content && Array.isArray(item.content)) {
            // The content property is an array of InputText objects
            text = item.content.map((c) => c.text).filter(Boolean).join(' ');
          }
          // Some items (e.g. audio) may have a transcript property
          if (!text && item.transcript) {
            text = item.transcript;
          }
          if (text) {
            transcriptManager.add(`${roleLabel}: ${text}`);
          }
        } else if (event.type === 'handoff') {
          // When a handoff event occurs the conversation is being transferred.
          transcriptManager.add('System: conversation handed off to a human agent');
        }
      }
    })();
    // Connect to the OpenAI realtime API.  Note that connecting after
    // registering the event loop ensures we capture all events.
    await session.connect({ apiKey: OPENAI_API_KEY });
    console.log('Connected to OpenAI realtime API');
    // When the WebSocket connection closes send the transcript via email
    connection.socket.on('close', async () => {
      if (!transcriptManager.isEmpty()) {
        const transcriptText = transcriptManager.get();
        try {
          if (LAW_FIRM_EMAIL) {
            await transporter.sendMail({
              from: SMTP_USER,
              to: LAW_FIRM_EMAIL,
              subject: 'Call transcript',
              text: transcriptText,
            });
          }
        } catch (error) {
          console.error('Error sending transcript email:', error);
        }
      }
    });
  } catch (err) {
    console.error('Realtime connection error:', err);
    connection.close();
  }
});

// Basic health-check route to verify the server is running
fastify.get('/', async () => {
  return { ok: true };
});

// Start the HTTP server.  Use the provided PORT or default to 3000.
const port = PORT ? parseInt(PORT) : 3000;
fastify.listen({ port }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`AI voice assistant server is listening on ${address}`);
});
