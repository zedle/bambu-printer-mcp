// Preload for the camera tool test: no network, and a fixed JPEG instead of the printer's RTSP stream.
import './inspection-no-network.mjs';
const { BambuImplementation } = await import('../../dist/printers/bambu.js');
BambuImplementation.prototype.fetchRtspCameraFrame = async () => Buffer.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
