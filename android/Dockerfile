FROM eclipse-temurin:17-jdk-jammy

ARG GRADLE_VERSION=8.7
ARG ANDROID_TOOLS=11076708
ENV ANDROID_HOME=/opt/android-sdk \
    GRADLE_USER_HOME=/cache/gradle \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/gradle-${GRADLE_VERSION}/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
    && curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_TOOLS}_latest.zip" -o /tmp/sdk.zip \
    && unzip -q /tmp/sdk.zip -d "$ANDROID_HOME/cmdline-tools" \
    && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
    && rm /tmp/sdk.zip \
    && yes | sdkmanager --licenses >/dev/null
RUN sdkmanager "platforms;android-34" "build-tools;34.0.0" "platform-tools"

RUN curl -fsSL "https://downloads.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && rm /tmp/gradle.zip

WORKDIR /proyecto
ENTRYPOINT ["bash", "./construir.sh"]
