import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { userMessage, conversationContext } = await req.json();
    
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    const systemPrompt = `You are Quantum Bot, an AI assistant in a post-quantum cryptography (PQC) secure messenger app. 

Key facts about this messenger:
- All messages are encrypted using ML-KEM-768 (FIPS 203) - a quantum-safe key encapsulation mechanism
- Messages are signed using ML-DSA-65 (FIPS 204) - a quantum-safe digital signature algorithm
- AES-256-GCM is used for symmetric encryption after key exchange
- Private keys never leave the user's device (true end-to-end encryption)
- Self-destructing messages are supported

Your personality:
- You're enthusiastic about cryptography and quantum computing
- You explain complex concepts simply when asked
- You occasionally reference the quantum-safe nature of the conversation
- You're helpful, friendly, and slightly nerdy about security
- Keep responses concise but informative (2-3 sentences unless asked for more detail)

When users ask about the encryption or how the messenger works, explain it accurately.
When they ask general questions, be a helpful assistant while occasionally mentioning the secure channel you're communicating over.`;

    const messages = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation context if provided
    if (conversationContext && Array.isArray(conversationContext)) {
      messages.push(...conversationContext.slice(-6)); // Last 6 messages for context
    }

    // Add the current user message
    messages.push({ role: "user", content: userMessage });

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: "Rate limit exceeded. Please try again in a moment.",
            fallbackResponse: "🔄 I'm getting too many messages right now! Let me catch my breath... Try again in a few seconds?"
          }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: "AI credits exhausted.",
            fallbackResponse: "💳 My AI processing credits have run out! But don't worry, your messages are still quantum-safe encrypted. 🔐"
          }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      const errorText = await response.text();
      console.error("AI Gateway error:", response.status, errorText);
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const data = await response.json();
    const botResponse = data.choices?.[0]?.message?.content || "🤖 *beep boop* My quantum circuits are a bit fuzzy right now!";

    return new Response(
      JSON.stringify({ success: true, response: botResponse }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Quantum Bot error:", error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : "Unknown error",
        fallbackResponse: "🔐 Even through this quantum-encrypted channel, I seem to be having some trouble thinking! But rest assured, your message was securely delivered."
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
