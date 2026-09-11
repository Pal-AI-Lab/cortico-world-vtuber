/**
 * VoxCPM2 语气词(方括号标签)。与演出词表无关:它们是 TTS 文本的一部分,
 * 合成出的音频里是一段真实发声(笑声/叹息/换气……)。解析器只放行这张表,
 * 表外的 [] 内容静默剥离,防止模型自造的标签被当成正文念出来。
 * 这张表属于 TTS 模型,不属于演出包。
 */
const VOICE_TAGS: readonly string[] = [
  'laughing',
  'sigh',
  'breath',
  'Uhm',
  'Shh',
  'Question-ah',
  'Question-ei',
  'Question-en',
  'Question-oh',
  'Confirmation-en',
  'Surprise-wa',
  'Surprise-yo',
  'Surprise-ah',
  'Surprise-oh',
  'Dissatisfaction-hnn',
];

const VOICE_TAG_BY_LOWER = new Map(VOICE_TAGS.map((t) => [t.toLowerCase(), t]));

export function voiceTags(): readonly string[] {
  return VOICE_TAGS;
}

/** 语气词归一:大小写不敏感,返回模型训练时的规范写法;表外返回 null */
export function resolveVoiceTag(raw: string): string | null {
  return VOICE_TAG_BY_LOWER.get(raw.trim().toLowerCase()) ?? null;
}
