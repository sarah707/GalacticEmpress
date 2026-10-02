// Isolated in-card preset for SillyTavern 1.19.x ChatCompletionService.
// It contains no endpoint, credential, model, Persona, worldbook, or chat-history slot.
// The game supplies all story-specific instructions as request messages.
export const BUILTIN_PRESET_SETTINGS = {
  temp_openai: 1,
  freq_pen_openai: 0,
  pres_pen_openai: 0,
  top_p_openai: 0.95,
  top_k_openai: 0,
  top_a_openai: 0,
  min_p_openai: 0,
  repetition_penalty_openai: 1,
  openai_max_context: 2000000,
  openai_max_tokens: 16384,
  max_context_unlocked: true,
  names_behavior: -1,
  send_if_empty: '',
  impersonation_prompt: '',
  new_chat_prompt: '',
  new_group_chat_prompt: '',
  new_example_chat_prompt: '',
  continue_nudge_prompt: '',
  wi_format: '{0}',
  scenario_format: '',
  personality_format: '',
  group_nudge_prompt: '',
  assistant_prefill: '',
  assistant_impersonation: '',
  use_sysprompt: true,
  squash_system_messages: true,
  media_inlining: false,
  inline_image_quality: 'auto',
  continue_prefill: false,
  continue_postfix: ' ',
  function_calling: false,
  tool_reasoning_mode: 'disabled',
  tool_call_recurse_limit: 1,
  show_thoughts: false,
  reasoning_effort: 'medium',
  verbosity: 'auto',
  enable_web_search: false,
  seed: -1,
  n: 1,
  request_images: false,
  request_image_aspect_ratio: '',
  request_image_resolution: '',
  openrouter_middleout: 'on',
  extensions: {},
  prompts: [],
  bias_preset_selected: '',
  custom_include_body: '',
  custom_exclude_body: '',
  custom_prompt_post_processing: '',
  stream_openai: false
};

// ChatCompletionService accepts preset-file keys rather than oai_settings aliases.
// Authority: SillyTavern 1.19.0 openai.js settingsToUpdate / custom-request.js.
export function cloneBuiltInRequestPreset() {
  const { prompts, ...preset } = JSON.parse(JSON.stringify(BUILTIN_PRESET_SETTINGS));
  const aliases = {
    temp_openai: 'temperature',
    freq_pen_openai: 'frequency_penalty',
    pres_pen_openai: 'presence_penalty',
    top_p_openai: 'top_p',
    top_k_openai: 'top_k',
    top_a_openai: 'top_a',
    min_p_openai: 'min_p',
    repetition_penalty_openai: 'repetition_penalty'
  };
  for (const [setting, key] of Object.entries(aliases)) {
    preset[key] = preset[setting];
    delete preset[setting];
  }
  return preset;
}
