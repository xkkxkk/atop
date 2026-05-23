/*
 * ATOP Report Integration - 外部Jenkins任务上报示例
 *
 * 使用场景：
 *   你有一个独立的Jenkins Job，不通过ATOP触发，但想把运行记录上报到ATOP平台
 *   复制以下代码集成到你的Pipeline脚本中即可
 *
 * 上报规则：
 *   1. 任务开始时上报一次（status=running）
 *   2. 每个阶段开始/结束时更新对应stage状态
 *   3. 任务结束时上报最终状态（success/failed/aborted）
 *
 * API文档：
 *   POST ${ATOP_URL}/api/report/pipeline
 *   无需Token，公开接口
 */

def ATOP_URL = "http://47.108.197.129:8080"  // 修改为你的ATOP地址
def PIPELINE_KEY = "my-jenkins-job"            // 任务唯一标识
def PIPELINE_NAME = "我的Jenkins任务"           // 显示名称（可选）

def atopReport(Map body) {
    try {
        body.pipelineKey = body.pipelineKey ?: PIPELINE_KEY
        body.pipelineName = body.pipelineName ?: PIPELINE_NAME
        def json = groovy.json.JsonOutput.toJson(body)
        sh(script: """curl -sf -X POST '${ATOP_URL}/api/report/pipeline' \\
            -H 'Content-Type: application/json' \\
            -d '${json.replace("'", "'\\''")}'""",
            returnStatus: true)
    } catch (Exception e) {
        echo "Warning: ATOP report failed: ${e.getMessage()}"
    }
}

node {
    def startTime = new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone('UTC'))
    def finalStatus = "failed"
    def errorMsg = ""

    // Initial report with stages list (so ATOP can show the plan)
    atopReport([
        buildId: currentBuild.number,
        buildUrl: env.BUILD_URL,
        status: "running",
        triggeredBy: env.BUILD_USER ?: "jenkins",
        startedAt: startTime,
        stages: [
            [stageKey: "build",  stageName: "编译构建", status: "pending"],
            [stageKey: "test",   stageName: "运行测试", status: "pending"],
            [stageKey: "deploy", stageName: "部署",    status: "pending"],
        ],
    ])

    try {
        // Stage 1: Build
        atopReport([
            buildId: currentBuild.number,
            status: "running",
            stages: [[stageKey: "build", stageName: "编译构建", status: "running",
                      startedAt: new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone('UTC')),
                      nodeName: env.NODE_NAME]],
        ])
        stage('Build') {
            def stageStart = System.currentTimeMillis()
            try {
                sh 'echo "building..." && sleep 5'
                atopReport([
                    buildId: currentBuild.number,
                    status: "running",
                    stages: [[stageKey: "build", stageName: "编译构建", status: "success",
                              finishedAt: new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone('UTC')),
                              durationMs: System.currentTimeMillis() - stageStart]],
                ])
            } catch (Exception e) {
                atopReport([
                    buildId: currentBuild.number,
                    status: "running",
                    stages: [[stageKey: "build", stageName: "编译构建", status: "failed",
                              errorSummary: e.getMessage(),
                              finishedAt: new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone('UTC')),
                              durationMs: System.currentTimeMillis() - stageStart]],
                ])
                throw e
            }
        }

        // Stage 2: Test
        // (similar pattern)

        // Stage 3: Deploy
        // (similar pattern)

        finalStatus = "success"
    } catch (Exception e) {
        def msg = e.getMessage() ?: "Unknown error"
        if (msg.contains("interrupt") || msg.contains("Aborted")) {
            finalStatus = "aborted"
        } else {
            finalStatus = "failed"
        }
        errorMsg = msg.take(500)
        throw e
    } finally {
        // Final report
        def finishedAt = new Date().format("yyyy-MM-dd'T'HH:mm:ss'Z'", TimeZone.getTimeZone('UTC'))
        atopReport([
            buildId: currentBuild.number,
            buildUrl: env.BUILD_URL,
            status: finalStatus,
            finishedAt: finishedAt,
            errorSummary: errorMsg,
        ])
    }
}
