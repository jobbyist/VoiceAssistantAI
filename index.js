import dotenv from 'dotenv';
import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { Twilio } from 'twilio';
// Import OpenAI realtime agent classes and Twilio transport layer.  These packages
// are not bundled with this repository by default – see package.json for
// dependencies and install them locally via `npm install`.
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents';
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
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  HUMAN_PHONE_NUMBER,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
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
  twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
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
    'Escalate the conversation to a human when the caller’s request requires legal advice or specialised assistance.',
  parameters: z.object({
    reason: z
      .string()
      .describe('Reason for requesting human assistance.'),
  }),
  execute: async ({ reason }) => {
    // Notify the law firm via email
    const subject = 'Call escalation requested';
    const body = `A caller requested human assistance: ${reason}`;
    if (LAW_FIRM_EMAIL) {
      await transporter.sendMail({
        from: SMTP_USER,
        to: LAW_FIRM_EMAIL,
        subject,
        text: body,
      });
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
    return 'Connecting you to a human representative for further assistance.';
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
You are an AI voice assistant for the Law Offices of Pritpal Singh.  
You can provide general information about California property law, assist callers with scheduling consultations, and help process payments for legal fees.  
Never provide specific legal advice or guarantee legal outcomes.  If a caller requests advice or information that requires legal judgement, use the \"escalate_to_human\" tool.  
When handling a scheduling or payment request, confirm details with the caller before proceeding.  
Use polite and concise language at all times.`,
  tools: [scheduleAppointmentTool, processPaymentTool, escalatetoHumanTool],
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
const WELCOME_GREETING =
  'Thank you for calling the Law Offices of Pritpal Singh. I am an AI assistant. How may I help you today?';

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