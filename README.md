<a id="readme-top"></a>

<h1 align="center">
  <a href="https://mobius.nutshellai.cn/">
    <img src="./mobius/extension/mobius-home/frontend/favicon.svg" width="56" alt="莫比乌斯 Logo" />
  </a>
  <br/>
  莫比乌斯: 可自进化的 Agent 操作系统
</h1>

<p align="center">
  <a href="https://mobius.nutshellai.cn/"><strong>官方网站</strong></a>
</p>



## 莫比乌斯：会生长、可进化的生产力系统

莫比乌斯是世界上第一个可根据任何自我迭代



莫比乌斯是一个面向真实项目协作的企业级 Agent 操作系统 （AgenticOS）。系统把项目、任务、执行会话和上下文管理放在同一个 Web 应用里，让用户可以直接在平台中提出需求、创建 Issue、启动 Session，并让 Agent 在绑定目录里完成实现、验证和汇报。




### 快速开始

#### 方式一：容器中安装和运行（所有操作系统，推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/nutshellai-tech/mobius.git
cd mobius

# 2. 生成配置（随机秘钥密码，可以手动配置跳过此步）
python3 conf_prepare.py --docker && python3 conf_check.py --docker

# 3. 构建 base 镜像（仅环境，不含代码）
docker build -t imac-mobius-base:latest -f deploy/Dockerfile . && docker build -t imac-mobius-exe:latest .

# 4. 启动
docker compose up
```

#### 方式二：直接部署（Linux or MacOS）

```bash
# 1. 安装 tmux git 等必要依赖
sudo apt install tmux python3 git curl proxychains openssh-server build-essential

# 2. 安装claude code和codex（其中之一即可，但建议都安装）
npm install -g @anthropic-ai/claude-code @openai/codex

# 3. 克隆仓库
git clone https://github.com/nutshellai-tech/mobius.git
cd mobius

# 4. 生成和配置秘钥（将会复制 .env.default 到 .env，并创建随机密码）
python3 conf_prepare.py && python3 conf_check.py

# 5. 安装项目依赖环境 （前端+后端）
cd ./mobius && npm install && cd ./frontend && npm install && cd ../..

# 6. 运行
python3 start.py
```
