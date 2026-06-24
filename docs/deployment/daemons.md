# Running as a Daemon

`sportsclaw listen` runs a bot in the foreground — fine for testing, but it stops when you
close your terminal. To keep a bot running, run it as a background daemon.

## Start and stop

```bash
sportsclaw start discord      # start a Discord bot in the background
sportsclaw start telegram     # …or Telegram

sportsclaw stop discord       # stop it
sportsclaw restart discord    # restart it
```

The installer sets up the process manager these commands use, so they work out of the box. (If
you installed manually, make sure `pm2` is installed globally.)

## Check status and logs

```bash
sportsclaw status                  # what's running, across all platforms
sportsclaw logs discord            # tail the bot's output
sportsclaw logs discord --lines 200
```

`status` also shows any running operator jobs — see **[Operator Mode](../advanced/operator)**.
