`speech-16khz.pcm` is the first second of Silero VAD's `tests/data/test.wav`
at commit `60b7ffa243625ebdc1070275a29f18c87843786a`, converted to mono,
16 kHz, signed 16-bit little-endian PCM. It is used to verify actual speech
detection rather than only checking inference on silence.

Source: https://github.com/snakers4/silero-vad/blob/60b7ffa243625ebdc1070275a29f18c87843786a/tests/data/test.wav

The upstream project is licensed under MIT.

Conversion:

```sh
ffmpeg -i test.wav -t 1 -ar 16000 -ac 1 -f s16le speech-16khz.pcm
```
