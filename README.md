# ollama-rocket-chat-bot

ollama-rocket-chat-bot is a Rocket.Chat bot that use ollama server to answer
users question.

# Required `.env` configuration file:

```
OLLAMA_URL=http://localhost:11434
ROCKETCHAT_URL=https://chat.localdomain
ROCKETCHAT_USER=ollama.dev.bot
ROCKETCHAT_PASSWORD=password

# List user allowed to use admin command
# Comma separated list of users
ADMIN_USERS=someuser1,someuser2
```

# Dependencies:

npm install @rocket.chat/sdk
npm install dotenv

# Run the bot:

node server.js

