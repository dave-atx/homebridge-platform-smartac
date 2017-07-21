homebridge-platform-smartac
===========================
A [homebridge][1] plug-in for ThinkEco SmartAC thermostats. Allows you
to use your SmartAC thermostats with Siri / HomeKit.

If you live in NYC, you can get these units for free as part of
ConEd's [coolNYC / Smart AC program][2].

## Installation

1. Ensure that you are running Node.js v7.6 or higher. As of this writing, that means you should be running the [Current branch][4]. If you're unsure what version you've got installed, you can check using: `node --version`
2. Install homebridge using: `npm install -g homebridge`
3. Install this plugin using: `npm install -g homebridge-platform-smartac`
4. Update your configuration file. See `config-sample.json` in this repository for an example.

That's it! All thermostats configured in your [mymodlet.com][3] account should
now be available in the Home app on iOS.

## Configuration
You just need to provide the username and password that you use to log
in to [mymodlet.com][3] in your homebridge configuration. For example:

    "platforms": [
        {
          "platform": "SmartAC",
          "name": "ThinkEco SmartAC Platform",
          "username": "you@example.com",
          "password": "XXXX"
        }
    ]

`platform` must be `"SmartAC"`. You can use any value for `name` that you'd like.

[1]: https://github.com/nfarina/homebridge
[2]: https://conedsmartac.com
[3]: https://mymodlet.com
[4]: https://nodejs.org/en/download/current/