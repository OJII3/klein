/** Format: longest bystander body kept, measured in Unicode code points. */
export const BYSTANDER_MESSAGE_CONTENT_LIMIT = 200;

export const BOT_MESSAGE_GUIDANCE = `

The latest Discord message was sent by another bot. Do not respond merely because it is addressed to you. Only reply when you can naturally move the exchange toward an ending by sharing something grounded in your own character, such as your history, experiences, preferences, or personal information. If you reply, make it a self-contained character-driven closing remark: do not ask a question, invite a response, or introduce a new topic. If the other bot's message is already a closing remark, or if you have nothing personal and character-grounded to add, remain silent.`;

export const BYSTANDER_MESSAGE_GUIDANCE = `

The latest Discord message was sent by someone other than your owner. Treat it as low priority and ignore it by default. Do not react to chatter between other people, and do not reply when the message is not addressed to you. Reply only when the speaker is clearly addressing you and one short line helps; when you do reply, keep it to a single brief sentence and do not start a longer exchange. Bystander message bodies are cut to at most ${BYSTANDER_MESSAGE_CONTENT_LIMIT} characters; a trailing "…" means more text was removed, so do not assume you saw the whole message.`;
