# Law Offices of Pritpal Singh AI Voice Assistant

This repository contains a Node.js application that turns a Twilio voice‑enabled phone number into a conversational AI assistant for a California‑based real‑estate law firm.  Callers can schedule appointments, ask general questions about California property law, pay legal fees and be escalated to a human when necessary.  A transcript of each call is emailed to the law firm at the end of the conversation.

## Background

Twilio’s **Media Streams** feature makes it possible to stream live audio from a phone call to a WebSocket.  By connecting that stream to the **OpenAI Realtime API**, you can build a truly interactive voice agent.  Twilio’s developer advocates note that “one of the most powerful ways to interact with an AI agent is to talk to it” and that using media streams lets you connect a Twilio number directly to OpenAI’s realtime model【332709063840717†L715-L720】.  Their tutorial demonstrates how to stream responses back over the call, integrate tool calling for actions like appointment scheduling, and manage output guardrails【332709063840717†L727-L732】.

To follow this tutorial you’ll need Node.js, a Twilio account with a voice‑enabled phone number, an OpenAI API key with Realtime API access, and a public HTTPS/WSS URL (ngrok works great during development)【332709063840717†L735-L744】.  The TwiML returned from your webhook greets the caller and opens a WebSocket back to your application【332709063840717†L782-L787】.  The OpenAI Realtime Agents SDK then handles speech recognition and audio generation over the Twilio media stream【332709063840717†L885-L886】.  Tools allow the agent to perform structured actions – such as scheduling an appointment – using schema validation with `zod`【332709063840717†L894-L934】, and guardrails can block prohibited terms or actions at runtime【332709063840717†L954-L999】.  In August 2025 OpenAI announced that the realtime API and a new model called **gpt‑realtime** were generally available with support for phone calling over SIP【198241787648345†L124-L151】.

This repository builds on those examples but tailors the agent for the **Law Offices of Pritpal Singh**.  The assistant provides general information about California property law, helps clients book consultations, processes payments and escalates the call to a human when necessary.  It supports English, Spanish and Mandarin callers.  At the end of each conversation it sends a transcript to the firm’s inbox.

## Features

* **Voice interaction** – A Twilio phone number (+1 510‑443‑2123) greets callers and streams audio to the OpenAI Realtime API.
* **Multilingual support** – The agent automatically detects and responds in English, Spanish or Mandarin, making the service accessible to a broader client base.
* **Rich instructions & guardrails** – The assistant is instructed to provide general information about California property law, avoid giving legal advice, include a mandatory disclaimer and maintain a warm, professional tone【213820349183228†L29-L38】.  Custom guardrails prevent disallowed topics.
* **Tool calling** – Four tools are defined using the OpenAI Agents SDK:
  * **`book_consultation`** – collects the caller’s name, phone, email, preferred date and time and consultation type.  It then emails a Calendly link to the client and creates a Stripe payment link for paid consultations.
  * **`schedule_appointment`** – a simpler appointment scheduler retained for backwards compatibility.  It records a preferred date, time and client name and notifies the law firm.
  * **`process_payment`** – records a payment amount, name and method and notifies the billing department.  When `STRIPE_SECRET_KEY` and a price ID are provided, the `book_consultation` tool uses Stripe to generate secure checkout links for the $500 consultation.
  * **`escalate_to_human`** – collects the caller’s reason for escalation plus their contact details and preferred follow‑up method.  It emails the escalation details to `ESCALATION_EMAIL` and can optionally dial a human representative via Twilio.
* **Calendly and Stripe integration** – Provide your own Calendly event links for each consultation type and a Stripe price ID for the paid consultation in the `.env` file.  The agent emails these links to callers automatically.
* **Transcripts** – Every history event from the realtime session is recorded.  When the call ends the conversation is compiled into a transcript and emailed to `LAW_FIRM_EMAIL`.
* **Modular configuration** – All secrets and configuration options live in a `.env` file.  See `.env.example` for details.

## Repository structure

```text
law-voice-assistant/
├── index.js        # Fastify server connecting Twilio to OpenAI Realtime API
├── package.json    # Node project metadata and dependencies
├── .env.example    # Template for environment variables
└── README.md       # This file
```

## Setup

1. **Clone this repository and install dependencies.**

   ```bash
   git clone https://github.com/your-user/law-voice-assistant.git
   cd law-voice-assistant
   npm install
   ```

   > **Note:** If you’re unable to install packages from npm in your environment, copy the dependencies listed in `package.json` into your project and install them where you have internet access.  The code depends on `fastify`, `@fastify/websocket`, `@fastify/formbody`, `@openai/agents`, `@openai/agents-extensions`, `zod`, `nodemailer` and `twilio`.

2. **Create a `.env` file.**  Copy `.env.example` to `.env` and populate the variables with your own values.

   * `PORT` – the port your server will run on locally (e.g. 3000).
   * `OPENAI_API_KEY` – your OpenAI API key with realtime API enabled.
   * `LAW_FIRM_EMAIL` – where call transcripts and most notifications should be sent (e.g. `info@pritsinghlaw.com`).
   * `ESCALATION_EMAIL` – where escalation requests should be delivered (e.g. `escalation@pritsinghlaw.com`).  If unset, escalations fall back to `LAW_FIRM_EMAIL`.
   * SMTP variables (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) – credentials for sending email.
   * Twilio variables (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) – optional, required only if you want the escalation tool to initiate a call to a human.
   * `HUMAN_PHONE_NUMBER` – the phone number to call when escalating.
   * Calendly variables (`CALENDLY_FREE_PHONE_LINK`, `CALENDLY_FREE_ZOOM_LINK`, `CALENDLY_PAID_ZOOM_LINK`, `CALENDLY_PAID_IN_PERSON_LINK`) – the scheduling links for each consultation type from your Calendly account.  The agent emails these to clients.
   * Stripe variables (`STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID_60_MIN`) – optional, required for the paid 1‑hour consultation.  Set these to your Stripe secret key and the price ID representing the $500 consultation.  When provided the agent generates a secure payment link via Stripe.

3. **Expose your server with ngrok for local testing.**

   The Twilio Voice webhook must be publicly accessible.  After starting your server, run the following in another terminal:

   ```bash
   ngrok http 3000
   ```

   Copy the `https://<subdomain>.ngrok.io` URL from ngrok.  In your Twilio console under **Voice > Phone Numbers > A Call Comes In**, set the webhook URL to `https://<subdomain>.ngrok.io/incoming-call` and select **HTTP POST**.  Save the configuration.

4. **Start the server.**

   ```bash
   node index.js
   ```

   When you call your Twilio number you should hear the greeting and be able to talk to the AI agent.  Try saying “I’d like to book a free fifteen‑minute Zoom consultation for next Tuesday” or “I need a one‑hour consultation in person,” and the agent will collect your details, send you a Calendly link, and, if necessary, generate a payment link.

## Deployment

### Vercel

Vercel’s serverless functions do not support persistent WebSocket connections out of the box.  To deploy this realtime application you will need to provision a **Vercel serverless function with a WebSocket adapter** or run your server in a long‑lived environment.  One option is to use Vercel’s Node.js runtime with `vercel.json` configured to treat `/incoming-call` and `/media-stream` as an `edge` or `lambda` function.  However, we recommend deploying to a platform that supports WebSockets natively, such as **Railway**, **Render**, **Fly.io** or **Heroku**.  If deploying on Vercel, disable the `Functions Timeout` limit and use Vercel’s Edge Runtime Beta for WebSocket support (subject to their current limitations).

### Alternative platforms

Platforms like **Railway**, **Render**, **Fly.io** and **Heroku** support long‑lived Node processes and WebSocket connections.  Deploying on one of these platforms generally involves:

1. Creating a new service from your Git repository.
2. Setting the environment variables defined in `.env.example` in the platform’s dashboard.
3. Opening the appropriate port and ensuring that the service can accept WebSocket connections.
4. Pointing your Twilio phone number’s webhook to the service URL.

## Security and compliance

* **No legal advice.**  The agent is instructed not to provide legal advice.  When a caller asks for specific guidance that requires legal judgement, the model calls the `escalate_to_human` tool, triggering a handoff to a human attorney.  You can further refine this by implementing guardrails that detect prohibited topics【332709063840717†L954-L999】.
* **Data handling.**  Transcripts are emailed to the firm for record‑keeping.  Consider storing these securely in a database or CRM if long‑term storage is required.  Never log or transmit sensitive client information insecurely.
* **Payments.**  The `book_consultation` tool can integrate with Stripe to collect payment for paid consultations.  Provide your Stripe secret key and price ID in `.env`, and the agent will generate a hosted checkout link that handles sensitive card data for you.  Ensure PCI compliance and never log full card numbers on your server.

## Extending this project

* Integrate with other calendar systems (Google Calendar, Microsoft Outlook) or CRM tools to automatically record appointments.
* Extend multilingual support beyond English, Spanish and Mandarin by adding language detection and translation functions.
* Perform sentiment analysis or analytics by processing the transcript data.
* Add more tools (e.g. to check case status or send documents) using the OpenAI Agents SDK’s function calling mechanism.

## License

This project is licensed under the MIT License.  See the `LICENSE` file for details.