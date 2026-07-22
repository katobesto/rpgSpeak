// Apéndice de dirección de dinamismo — se añade DESPUÉS de cualquier plantilla de
// prompt de escena (incluidas las personalizadas por el usuario). Ataca las posturas
// estáticas y las "miradas perdidas": pose desde la acción, lenguaje corporal desde
// la emoción, mirada dirigida a un objetivo concreto, interacción y cámara.
// Compartido entre la generación de escena del chat (generate.routes.ts) y la
// generación de escena/pose en la galería de personaje (character.service.ts).
export const DYNAMISM_BLOCK =
  `\n\nDYNAMISM & DIRECTION — MANDATORY (overrides any generic or default posing):\n` +
  `Compose a living, in-motion moment — never a static line-up of front-facing portraits.\n` +
  `- POSE FROM ACTION: for each character, read what they are physically DOING in "THE MOMENT TO DEPICT" and translate it into a specific, readable body pose and gesture (reaching, turning away, leaning in, recoiling, gripping something, mid-step, crouching, embracing…). Never fall back to "standing, arms at sides, facing forward".\n` +
  `- BODY LANGUAGE FROM EMOTION: derive posture, hands and muscle tension from each character's emotion in this beat (tense shoulders, clenched fists, open relaxed stance, defensive crossed arms, weight shifted onto one leg, chin raised or lowered…).\n` +
  `- GAZE — CRITICAL, NO EMPTY STARES: give every character eyes ACTIVELY DIRECTED at a concrete target present in the scene — another character's face, their own hands, an object, the source of the action — and state that target explicitly (e.g. "locking eyes with X", "glancing down at the letter", "eyes fixed on the door"). Add engaged eye detail (narrowed, widened, sidelong glance, half-lidded). STRICTLY FORBIDDEN unless the beat explicitly demands it: vacant stare, empty or dead eyes, blank expression, unfocused or lost gaze, staring into the distance or at nothing, and looking straight at the camera. The eyes must carry the emotion of the moment.\n` +
  `- INTERACTION & BLOCKING: place characters in a clear relationship to each other and to the action (facing off, one stepping toward or away from another, a hand on a shoulder, back turned, shielding someone, closing distance) so they share the same moment instead of posing side by side.\n` +
  `- CAMERA & FRAMING: choose an angle and shot that serve THIS beat (low angle for power, over-the-shoulder for confrontation, close-up for intimacy or tension, wide establishing shot for a calmer beat, a slight dutch tilt for unease). Avoid a flat, eye-level, centered group portrait unless the moment is genuinely calm and still.`;
