class PcmDownsampleProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSize = 800;
    this.inputBuffer = [];
    this.outputFrame = [];
    this.offset = 0;
    this.ratio = sampleRate / this.targetRate;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    for (let i = 0; i < input.length; i += 1) {
      this.inputBuffer.push(input[i]);
    }

    while (this.offset + this.ratio <= this.inputBuffer.length) {
      const start = Math.floor(this.offset);
      const end = Math.max(start + 1, Math.floor(this.offset + this.ratio));
      let sum = 0;
      let count = 0;

      for (let i = start; i < end && i < this.inputBuffer.length; i += 1) {
        sum += this.inputBuffer[i];
        count += 1;
      }

      this.outputFrame.push(count > 0 ? sum / count : 0);
      this.offset += this.ratio;

      if (this.outputFrame.length >= this.frameSize) {
        const pcm = new ArrayBuffer(this.frameSize * 2);
        const view = new DataView(pcm);

        for (let i = 0; i < this.frameSize; i += 1) {
          const sample = Math.max(-1, Math.min(1, this.outputFrame[i] || 0));
          view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }

        this.outputFrame = this.outputFrame.slice(this.frameSize);
        this.port.postMessage(pcm, [pcm]);
      }
    }

    const discard = Math.floor(this.offset);
    if (discard > 0) {
      this.inputBuffer.splice(0, discard);
      this.offset -= discard;
    }

    return true;
  }
}

registerProcessor('pcm-downsample-processor', PcmDownsampleProcessor);
