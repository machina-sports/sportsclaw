# Images & Vision

sportsclaw can both **create** images and **read** them.

## Generating graphics

Ask for a graphic and the agent makes one and delivers it right into the chat or saves it
locally:

```bash
sportsclaw "Make a hype graphic for tonight's Lakers game"
```

In a Discord or Telegram bot, the image is posted straight into the conversation.

::: tip Provider requirement
Image generation needs **OpenAI or Google** as your model provider — Anthropic models can't
produce images. See [Configuration](../getting-started/configuration).
:::

## Reading images (vision)

Send sportsclaw an image and ask about it — a screenshot of a bracket, a scoreboard, a betting
slip — and it reads the picture as part of the question:

- **Discord / Telegram** — attach an image and ask in the same message.
- **CLI** — pass an image file path along with your question.

Vision works on any vision-capable model you've connected.
