// Curated content decks for interactive prompts.
//
// Three decks — Would You Rather, Truth or Dare, and deep conversation
// prompts (confessions / story mode). The server picks randomly and avoids
// repeats within the same room.

const WOULD_YOU_RATHER = [
  'Would you rather be able to fly or be invisible?',
  'Would you rather live in the past or the future?',
  'Would you rather have unlimited money or unlimited time?',
  'Would you rather know every language or play every instrument?',
  'Would you rather always say what you think or never speak again?',
  'Would you rather explore space or the deep ocean?',
  'Would you rather have no internet or no air conditioning/heating?',
  'Would you rather be famous for something you didn\'t do or unknown for something incredible?',
  'Would you rather eat only pizza or only tacos for the rest of your life?',
  'Would you rather always be 10 minutes late or 20 minutes early?',
  'Would you rather have the power to read minds or see the future?',
  'Would you rather live without music or without movies?',
  'Would you rather be the funniest person in the room or the smartest?',
  'Would you rather have a rewind button or a pause button for your life?',
  'Would you rather never age physically or never age mentally?',
  'Would you rather be able to talk to animals or speak every human language?',
  'Would you rather live in a treehouse or on a houseboat?',
  'Would you rather have free Wi-Fi everywhere or free coffee everywhere?',
  'Would you rather always know when someone is lying or always get away with lying?',
  'Would you rather lose your sense of taste or your sense of touch?',
  'Would you rather be a famous musician or a famous actor?',
  'Would you rather live in a world without color or a world without sound?',
  'Would you rather control fire or control water?',
  'Would you rather have a photographic memory or an IQ of 200?',
  'Would you rather be stuck in an elevator with your worst enemy or your ex?',
  'Would you rather give up social media or give up watching TV/movies forever?',
  'Would you rather be the best player on a losing team or the worst on a winning team?',
  'Would you rather have the ability to teleport or to stop time?',
  'Would you rather live in a tiny house or a mansion you can never leave?',
  'Would you rather always have to sing instead of speaking or dance everywhere you walk?',
  'Would you rather have a personal chef or a personal trainer for life?',
  'Would you rather know the date of your death or the cause of your death?',
  'Would you rather be the first person to explore a new planet or invent something that changes the world?',
  'Would you rather have the superpower of super speed or super strength?',
  'Would you rather always feel too hot or always feel too cold?',
  'Would you rather be able to breathe underwater or have wings?',
  'Would you rather only eat raw food or only eat canned food?',
  'Would you rather live in a world where there are no problems or a world where you rule?',
  'Would you rather have a third eye or a third arm?',
  'Would you rather be able to shrink to the size of an ant or grow to the size of a building?',
  'Would you rather be feared or loved?',
  'Would you rather know how everyone you meet dies or when everyone you meet dies?',
  'Would you rather never get stuck in traffic again or never get a cold again?',
  'Would you rather have unlimited battery on all devices or unlimited fuel for a car?',
  'Would you rather go to jail for a year or lose a year of your life from the end?',
  'Would you rather have an extra hour every day or an extra day every week?',
  'Would you rather be completely alone for 5 years or never be alone for 5 years?',
  'Would you rather be the hero or the villain in a movie?',
  'Would you rather be able to copy-paste in real life or undo in real life?',
  'Would you rather have all your texts read aloud by a celebrity or have your life narrated by Morgan Freeman?',
  'Would you rather only listen to one song for the rest of your life or never listen to the same song twice?',
  'Would you rather lose the ability to lie or believe everything you\'re told?',
  'Would you rather be immune to hangovers or immune to getting sunburned?',
  'Would you rather have a pause button or a mute button for real life?',
  'Would you rather always know the right thing to say or always know the right thing to do?',
  'Would you rather your thoughts be broadcasted to everyone or never be able to think in silence?',
  'Would you rather be locked in a library or locked in a gym?',
  'Would you rather always have a runny nose or always have chapped lips?',
  'Would you rather give up breakfast or give up dinner?',
  'Would you rather have the ability to talk to your younger self or your older self?',
  'Would you rather be able to remember everything or forget anything you want?',
  'Would you rather be famous online or famous in real life?',
  'Would you rather live where it only snows or where it only rains?',
  'Would you rather be really lucky or really talented?',
  'Would you rather only wear one color for the rest of your life or never wear the same outfit twice?',
  'Would you rather be trapped in a video game or trapped in a movie?',
  'Would you rather always have perfect hair or always have a perfect smile?',
  'Would you rather be an Olympic gold medalist or a Nobel Prize winner?',
  'Would you rather have a jetpack or a flying car?',
  'Would you rather wake up in a new random country every morning or never leave the country you were born in?',
  'Would you rather have your dream job with a terrible boss or a boring job with an amazing boss?',
  'Would you rather be the best cook in the world or the best dancer?',
  'Would you rather have a talking dog or a talking cat?',
  'Would you rather live in the Harry Potter universe or the Marvel universe?',
  'Would you rather only be able to whisper or only be able to shout?',
  'Would you rather have legs as long as your fingers or fingers as long as your legs?',
  'Would you rather find true love or win the lottery?',
  'Would you rather always have to tell the truth or always have to lie?',
  'Would you rather be a genius everyone thinks is an idiot or an idiot everyone thinks is a genius?',
  'Would you rather be stuck on a deserted island alone or with someone you can\'t stand?'
];

const TRUTHS = [
  'What\'s the most embarrassing thing you\'ve ever done?',
  'What\'s a secret you\'ve never told anyone?',
  'What\'s the weirdest dream you\'ve ever had?',
  'Have you ever pretended to like a gift you hated?',
  'What\'s the most childish thing you still do?',
  'What\'s your guilty pleasure?',
  'What would you do if you were invisible for a day?',
  'What\'s the biggest lie you\'ve ever told?',
  'Who was your most embarrassing crush?',
  'What is your deepest fear?',
  'What\'s the worst date you\'ve ever been on?',
  'If you could switch lives with anyone for a day, who would it be?',
  'What\'s a habit you wish you could break?',
  'What\'s the most rebellious thing you did as a teenager?',
  'If you could erase one memory, what would it be?',
  'What\'s the strangest compliment you\'ve received?',
  'What\'s the pettiest reason you\'ve stopped talking to someone?',
  'What\'s the most awkward thing you\'ve said on a date?',
  'What\'s a movie that made you ugly-cry?',
  'What\'s the longest you\'ve gone without showering?',
  'What\'s something most people love that you secretly hate?',
  'Have you ever snooped through someone\'s phone?',
  'What\'s the most embarrassing thing in your search history?',
  'What\'s a song you secretly love but would never admit to?',
  'If you had to describe yourself in three words, what would they be?',
  'What\'s the scariest thing that has ever happened to you?',
  'What\'s the funniest thing that ever happened to you in public?',
  'What is the one thing you\'re most passionate about?',
  'If you could relive one day, which day would you pick?',
  'What\'s the nicest thing a stranger has ever done for you?',
  'What\'s your most controversial opinion?',
  'What\'s something you\'ve done that you\'re really proud of but never talk about?',
  'What was the first thing you thought about this morning?',
  'What\'s the worst fashion choice you\'ve ever made?',
  'If your life was a movie, what genre would it be?',
  'What\'s a talent you have that no one knows about?',
  'What\'s the bravest thing you\'ve ever done?',
  'What\'s the worst advice you\'ve ever taken?',
  'What\'s one thing on your bucket list?',
  'What would your superpower be and why?'
];

const DARES = [
  'Do your best impression of a celebrity for 30 seconds.',
  'Sing the chorus of the last song you listened to.',
  'Talk in an accent for the next 2 minutes.',
  'Tell a joke — the worse it is, the better.',
  'Describe the room you\'re in without saying any colors.',
  'Rap about your day so far.',
  'Say the alphabet backwards as fast as you can.',
  'Speak only in questions for the next minute.',
  'Give a 30-second motivational speech about anything.',
  'Do a dramatic reading of the last text message you received.',
  'Describe your dream vacation in the most dramatic way possible.',
  'Make up a word and give it a convincing definition.',
  'Tell a two-sentence horror story.',
  'Narrate what you\'re doing right now like a nature documentary.',
  'Give a one-minute TED talk on the most random topic you can think of.',
  'Speak in rhymes for the next minute.',
  'Give your best evil villain laugh.',
  'Describe yourself as a real estate listing.',
  'Make up a conspiracy theory and sell it convincingly.',
  'Tell a story where every sentence starts with the next letter of the alphabet.',
  'Do a 15-second beatbox performance.',
  'Explain your favorite movie plot but make it sound terrible.',
  'Give a dramatic weather report for your current location.',
  'Speak with no pauses for 30 seconds straight.',
  'Pretend you\'re accepting an award — give an acceptance speech.',
  'Describe your morning routine as if it were an epic adventure.',
  'Make animal sounds for 15 seconds.',
  'Tell the other person three things about yourself — two truths and one lie.',
  'Say tongue twisters as fast as you can for 20 seconds.',
  'Describe what you look like without mentioning body parts.',
  'Create a 10-second jingle for the most boring product you can think of.',
  'Tell the cheesiest pickup line you know.',
  'Do your best robot voice for 30 seconds.',
  'Explain something simple (like tying shoes) in the most complicated way.',
  'Freestyle about the person you\'re talking to (based on their voice).',
  'Tell a bedtime story in 30 seconds.',
  'Be a sports commentator narrating everyday activities.',
  'Do an impression of a stereotypical movie trailer narrator.',
  'Try to make the other person laugh using only sounds, no words.',
  'Describe the plot of a movie but replace every noun with \"banana\".'
];

const DEEP_PROMPTS = [
  'What\'s something you believe that most people would disagree with?',
  'Tell me about a moment that completely changed how you see the world.',
  'What\'s the hardest thing you\'ve ever had to forgive?',
  'If you could send a message to your 10-year-old self, what would you say?',
  'What does happiness look like to you right now?',
  'What\'s a fear you\'ve overcome, and how did you do it?',
  'Tell me about someone who shaped who you are today.',
  'What\'s the most important lesson you learned the hard way?',
  'If money and time were no object, how would you spend your days?',
  'What\'s something about you that people always get wrong?',
  'What\'s the kindest thing you\'ve done that nobody knows about?',
  'What keeps you up at night?',
  'Tell me about a time you felt truly alive.',
  'What\'s a dream you\'ve given up on, and do you regret it?',
  'What does "home" mean to you?',
  'If you could have dinner with anyone, living or dead, who and why?',
  'What\'s the most meaningful compliment you\'ve ever received?',
  'What\'s something you wish more people understood about you?',
  'Tell me about a crossroads in your life and the path you chose.',
  'What legacy do you want to leave behind?',
  'What\'s a question you wish someone would ask you?',
  'What\'s the most beautiful thing you\'ve ever seen?',
  'If you could change one thing about the world, what would it be?',
  'What\'s a vulnerability that turned out to be a strength?',
  'Tell me about a stranger who made an unexpected impact on your life.',
  'What does love mean to you?',
  'What\'s something you\'re grateful for that most people take for granted?',
  'What would you do differently if you knew nobody would judge you?',
  'What\'s the biggest risk you\'ve ever taken?',
  'If today were your last day, what would you want to do?',
  'What\'s a belief you held strongly that you later changed your mind about?',
  'Tell me about a time you felt completely at peace.',
  'What do you think is the meaning of life?',
  'What\'s the most important relationship in your life and why?',
  'What\'s a moment of failure that you\'re now thankful for?',
  'If you could master any skill overnight, what would you choose?',
  'What emotion do you feel most often? What emotion do you wish you felt more?',
  'What\'s a conversation you wish you\'d had with someone but never did?',
  'What does courage look like to you?',
  'Tell me about a time when a small act of kindness changed your day.',
  'What part of your culture or background are you most proud of?',
  'What would you want people to say about you at your funeral?',
  'What\'s the most profound thing a child has ever said to you?',
  'If you could experience one thing for the first time again, what would it be?',
  'What\'s a wall you\'ve built around yourself, and have you tried to take it down?',
  'What does forgiveness mean to you?',
  'What is one thing you want to be remembered for?',
  'If you could solve one problem in the world, what would it be?',
  'What is the bravest thing you\'ve ever said?',
  'What makes you feel most connected to other people?'
];

/**
 * Pick a random entry from a deck, avoiding ones already used in this room.
 *
 * @param {'wyr' | 'truth' | 'dare' | 'deep'} type
 * @param {Set<number>} usedIndices — indices already shown in this room
 * @returns {{ text: string, index: number, type: string } | null}
 */
export function pickPrompt(type, usedIndices = new Set()) {
  const deck = DECKS[type];
  if (!deck) return null;

  const available = [];
  for (let i = 0; i < deck.length; i++) {
    if (!usedIndices.has(i)) available.push(i);
  }

  if (available.length === 0) {
    // All used — reset and pick any.
    const i = Math.floor(Math.random() * deck.length);
    return { text: deck[i], index: i, type };
  }

  const i = available[Math.floor(Math.random() * available.length)];
  return { text: deck[i], index: i, type };
}

const DECKS = {
  wyr: WOULD_YOU_RATHER,
  truth: TRUTHS,
  dare: DARES,
  deep: DEEP_PROMPTS
};

/**
 * Pick a random truth or dare (50/50 split).
 * @param {Set<number>} usedTruthIndices
 * @param {Set<number>} usedDareIndices
 */
export function pickTruthOrDare(usedTruthIndices = new Set(), usedDareIndices = new Set()) {
  const isTruth = Math.random() < 0.5;
  if (isTruth) {
    const result = pickPrompt('truth', usedTruthIndices);
    return result ? { ...result, label: 'Truth' } : null;
  }
  const result = pickPrompt('dare', usedDareIndices);
  return result ? { ...result, label: 'Dare' } : null;
}
