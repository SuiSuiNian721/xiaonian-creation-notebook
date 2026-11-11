SHARED_SCHEMAS.AI_TOOLKIT({
  "label": "SD 1.5",
  "arch": "sd1",
  "modes": [
    "model_directory",
    "single_file"
  ],
  "components": [
    "unet",
    "text_encoder",
    "vae"
  ],
  "tokenizers": [
    "tokenizer"
  ],
  "scheduler": "ddpm",
  "quantization": false,
  "family": "sd15",
  "train_types": [
    "ai-toolkit-sd15-lora"
  ]
})
