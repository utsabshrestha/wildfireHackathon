/**
 * Mock flight booking agent.
 * Uses keyword matching to simulate a conversational AI agent.
 * Replace this with a real LLM call in production.
 */

const responses = [
  {
    keywords: ['hello', 'hi', 'hey', 'good morning', 'good afternoon'],
    reply: "Hello! I'm your flight booking assistant. Where would you like to travel today?",
  },
  {
    keywords: ['new york', 'jfk', 'lga', 'ewr', 'newark'],
    reply: "Got it — departing from New York. Where would you like to fly to?",
  },
  {
    keywords: ['london', 'lhr', 'heathrow', 'gatwick', 'lgw'],
    reply: "London is a great choice! What dates are you looking to travel?",
  },
  {
    keywords: ['paris', 'cdg', 'charles de gaulle', 'orly'],
    reply: "Paris it is! What dates work for you?",
  },
  {
    keywords: ['tokyo', 'nrt', 'narita', 'hnd', 'haneda'],
    reply: "Tokyo is wonderful! When would you like to fly?",
  },
  {
    keywords: ['los angeles', 'lax', 'la', 'california'],
    reply: "Los Angeles! What dates are you considering?",
  },
  {
    keywords: ['friday', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday'],
    reply: "Got the date. How many passengers will be traveling?",
  },
  {
    keywords: ['next week', 'this week', 'next month'],
    reply: "Noted the timeframe. How many passengers will be traveling?",
  },
  {
    keywords: ['one passenger', 'just me', 'solo', '1 passenger', 'one person'],
    reply: "Perfect, one passenger. Would you like economy, business, or first class?",
  },
  {
    keywords: ['two', '2 passenger', 'two passenger', 'couple', 'two people'],
    reply: "Two passengers noted. Would you like economy, business, or first class?",
  },
  {
    keywords: ['economy', 'coach'],
    reply: "Economy class selected. I found several options. The cheapest fare is $420 on British Airways departing at 9:15 AM. Shall I book that for you?",
  },
  {
    keywords: ['business', 'business class'],
    reply: "Business class selected. I found availability starting at $2,100 on American Airlines. Shall I proceed with the booking?",
  },
  {
    keywords: ['first class', 'first'],
    reply: "First class! I found a seat on Emirates for $4,800 with full flat-bed and gourmet dining. Shall I book it?",
  },
  {
    keywords: ['yes', 'book', 'confirm', 'proceed', 'go ahead', 'sounds good'],
    reply: "Excellent! I'm filling in your booking details now. Please confirm your passenger information on the form.",
  },
  {
    keywords: ['no', 'cancel', 'stop', 'never mind', 'different'],
    reply: "No problem! Would you like to search for different options or change the destination?",
  },
  {
    keywords: ['thank', 'thanks', 'great', 'perfect', 'awesome'],
    reply: "You're welcome! Is there anything else I can help you with for your trip?",
  },
  {
    keywords: ['cheap', 'cheapest', 'budget', 'affordable', 'low cost'],
    reply: "Looking for budget-friendly options! I found flights starting at $189 on Spirit Airlines. Want me to check other carriers too?",
  },
  {
    keywords: ['direct', 'nonstop', 'non-stop'],
    reply: "Filtering for nonstop flights only. I found 2 nonstop options for your route. Shall I show you the details?",
  },
]

/**
 * Returns a mock agent response based on keyword matching.
 * @param {string} text - The user's transcribed speech
 * @returns {string} - The agent's reply
 */
export function getResponse(text) {
  const lower = text.toLowerCase()

  for (const { keywords, reply } of responses) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return reply
    }
  }

  // Default fallback
  return `I heard: "${text}". I can help you search for flights, check availability, and book tickets. Try saying something like "I want to fly from New York to London next Friday".`
}
