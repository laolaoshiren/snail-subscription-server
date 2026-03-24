"use strict";

const { createSnailVendor } = require("../../shared/createSnailVendor");

module.exports = createSnailVendor({
  id: "snail-default",
  label: "主上游",
  description: "默认生产上游，供实际中转使用。",
});
