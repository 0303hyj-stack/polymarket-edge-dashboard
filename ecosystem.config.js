module.exports = {
  apps: [{
    name: 'paper-bot',
    script: 'paper-trading-ws.js',
    cwd: '/Users/hwang-yeji/polymarket-edge-dashboard',

    // 자동 재시작 설정
    autorestart: true,
    watch: false,
    max_restarts: 999999,
    restart_delay: 5000,        // 재시작 전 5초 대기

    // 메모리 제한 (넘으면 자동 재시작)
    max_memory_restart: '1G',

    // 크래시 시 재시작
    exp_backoff_restart_delay: 100,

    // 로그 설정
    error_file: '/Users/hwang-yeji/polymarket-edge-dashboard/pm2-error.log',
    out_file: '/Users/hwang-yeji/polymarket-edge-dashboard/pm2-out.log',
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    // 환경 변수
    env: {
      NODE_ENV: 'production'
    }
  }]
};
