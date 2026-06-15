/**
 * ElevenLabs voices (pre-made library voice IDs — exist on every account).
 * NOTE: Mongolian is not officially supported by ElevenLabs TTS; v3 will
 * attempt it but quality varies — test before relying on it. You can also
 * paste a custom/cloned voice ID.
 */
export const ELEVENLABS_VOICES: { value: string; label: string }[] = [
  { value: "21m00Tcm4TlvDq8ikWAM", label: "Rachel (эмэгтэй, тайван) ⭐" },
  { value: "EXAVITQu4vr4xnSDxMaL", label: "Bella (эмэгтэй, зөөлөн)" },
  { value: "AZnzlk1XvdvUeBnXmlld", label: "Domi (эмэгтэй, эрч хүчтэй)" },
  { value: "MF3mGyEYCl7XYWbV9V6O", label: "Elli (эмэгтэй, залуу)" },
  { value: "pNInz6obpgDQGcFmaJgB", label: "Adam (эрэгтэй, гүн)" },
  { value: "ErXwobaYiN019PkySvjV", label: "Antoni (эрэгтэй, дулаан)" },
  { value: "TxGEqnHWrfWFTfGW9XjX", label: "Josh (эрэгтэй, залуу)" },
  { value: "VR6AewLTigWG4xSOukaG", label: "Arnold (эрэгтэй, хатуу)" },
];

/** Chimege /synthesize voices — Mongolian-native, single-speaker model. */
export const CHIMEGE_VOICES: { value: string; label: string }[] = [
  { value: "FEMALE3v2", label: "FEMALE3v2 (эмэгтэй, дулаан) ⭐" },
  { value: "FEMALE1", label: "FEMALE1 (эмэгтэй, сонгодог)" },
  { value: "FEMALE1v2", label: "FEMALE1v2 (эмэгтэй, тод)" },
  { value: "FEMALE2v2", label: "FEMALE2v2 (эмэгтэй, дунд нас)" },
  { value: "FEMALE4v2", label: "FEMALE4v2 (эмэгтэй, шинэхэн)" },
  { value: "FEMALE5v2", label: "FEMALE5v2 (эмэгтэй, нам)" },
  { value: "MALE1", label: "MALE1 (эрэгтэй, сонгодог)" },
  { value: "MALE1v2", label: "MALE1v2 (эрэгтэй, тогтуун)" },
  { value: "MALE2v2", label: "MALE2v2 (эрэгтэй, залуу)" },
  { value: "MALE3v2", label: "MALE3v2 (эрэгтэй, дунд нас)" },
  { value: "MALE4v2", label: "MALE4v2 (эрэгтэй, дулаан)" },
];

/**
 * 30 Gemini TTS prebuilt voices, mirrored from the Whisperly desktop app.
 * Each has a distinct tone — listed here so the user can pick before render.
 */
export const GEMINI_VOICES: { value: string; label: string }[] = [
  { value: "Achernar", label: "Achernar (эмэгтэй — зөөлөн)" },
  { value: "Achird", label: "Achird (эрэгтэй — найрсаг)" },
  { value: "Algenib", label: "Algenib (эрэгтэй — хатуу)" },
  { value: "Algieba", label: "Algieba (эрэгтэй — жигд)" },
  { value: "Alnilam", label: "Alnilam (эрэгтэй — тогтуун)" },
  { value: "Aoede", label: "Aoede (эмэгтэй — салхи)" },
  { value: "Autonoe", label: "Autonoe (эмэгтэй — тод)" },
  { value: "Callirrhoe", label: "Callirrhoe (эмэгтэй — хөнгөн)" },
  { value: "Charon", label: "Charon (эрэгтэй — мэдээллийн)" },
  { value: "Despina", label: "Despina (эмэгтэй — жигд)" },
  { value: "Enceladus", label: "Enceladus (эрэгтэй — амьсгалуу)" },
  { value: "Erinome", label: "Erinome (эмэгтэй — тод)" },
  { value: "Fenrir", label: "Fenrir (эрэгтэй — догдлох)" },
  { value: "Gacrux", label: "Gacrux (эмэгтэй — туршлагатай)" },
  { value: "Iapetus", label: "Iapetus (эрэгтэй — тод)" },
  { value: "Kore", label: "Kore (эмэгтэй — тогтуун) ⭐" },
  { value: "Laomedeia", label: "Laomedeia (эмэгтэй — баяртай)" },
  { value: "Leda", label: "Leda (эмэгтэй — залуу)" },
  { value: "Orus", label: "Orus (эрэгтэй — тогтуун)" },
  { value: "Puck", label: "Puck (эрэгтэй — баяртай)" },
  { value: "Pulcherrima", label: "Pulcherrima (эмэгтэй — шууд)" },
  { value: "Rasalgethi", label: "Rasalgethi (эрэгтэй — мэдээллийн)" },
  { value: "Sadachbia", label: "Sadachbia (эрэгтэй — амьд)" },
  { value: "Sadaltager", label: "Sadaltager (эрэгтэй — мэдлэгтэй)" },
  { value: "Schedar", label: "Schedar (эрэгтэй — тэгш)" },
  { value: "Sulafat", label: "Sulafat (эмэгтэй — дулаан)" },
  { value: "Umbriel", label: "Umbriel (эрэгтэй — хөнгөн)" },
  { value: "Vindemiatrix", label: "Vindemiatrix (эмэгтэй — дөлгөөн)" },
  { value: "Zephyr", label: "Zephyr (эмэгтэй — тод)" },
  { value: "Zubenelgenubi", label: "Zubenelgenubi (эрэгтэй — энгийн)" },
];
