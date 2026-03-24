"use strict";

const { createSnailVendor } = require("../../shared/createSnailVendor");

module.exports = createSnailVendor({
  id: "snail-test",
  label: "测试上游",
  description: "测试用镜像上游，逻辑与主上游一致，仅用于验证多上游切换。",
});
